defmodule SymphonyElixir.StatusDashboard do
  @moduledoc """
  Renders a status snapshot for orchestrator and worker activity as a
  terminal UI.

  This module is the GenServer coordinator. It owns the dashboard
  state, polls the orchestrator for snapshots, and decides what to
  render and when. The actual work is delegated:

  * `SymphonyElixir.StatusDashboard.Styling` — ANSI codes, column
    widths, and the small formatting primitives shared by every row.
  * `SymphonyElixir.StatusDashboard.SnapshotFormatter` — pure
    data-in / strings-out functions that turn a snapshot into the
    rendered frame.
  * `SymphonyElixir.StatusDashboard.RenderScheduler` — throttle and
    interval logic that decides when to render and when to enqueue.
  * `SymphonyElixir.StatusDashboard.CodexMessage` — humanizes Codex
    event/message payloads.
  """

  use GenServer
  require Logger

  alias SymphonyElixir.{Config, Orchestrator}
  alias SymphonyElixir.StatusDashboard.{CodexMessage, RenderScheduler, SnapshotFormatter, Styling}
  alias SymphonyElixirWeb.ObservabilityPubSub

  @throughput_window_ms 5_000

  defstruct [
    :refresh_ms,
    :enabled,
    :render_interval_ms,
    :refresh_ms_override,
    :enabled_override,
    :render_interval_ms_override,
    :render_fun,
    :token_samples,
    :last_tps_second,
    :last_tps_value,
    :last_rendered_content,
    :last_rendered_at_ms,
    :pending_content,
    :flush_timer_ref,
    :last_snapshot_fingerprint
  ]

  @type t :: %__MODULE__{
          refresh_ms: pos_integer(),
          enabled: boolean(),
          render_interval_ms: pos_integer(),
          refresh_ms_override: pos_integer() | nil,
          enabled_override: boolean() | nil,
          render_interval_ms_override: pos_integer() | nil,
          render_fun: (String.t() -> term()),
          token_samples: [{integer(), integer()}],
          last_tps_second: integer() | nil,
          last_tps_value: float() | nil,
          last_rendered_content: String.t() | nil,
          last_rendered_at_ms: integer() | nil,
          pending_content: String.t() | nil,
          flush_timer_ref: reference() | nil,
          last_snapshot_fingerprint: term() | nil
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @spec notify_update(GenServer.name()) :: :ok
  def notify_update(server \\ __MODULE__) do
    ObservabilityPubSub.broadcast_update()

    case GenServer.whereis(server) do
      pid when is_pid(pid) ->
        send(pid, :refresh)
        :ok

      _ ->
        :ok
    end
  end

  @spec init(keyword()) :: {:ok, t()}
  def init(opts) do
    refresh_ms_override = keyword_override(opts, :refresh_ms)
    enabled_override = keyword_override(opts, :enabled)
    render_interval_ms_override = keyword_override(opts, :render_interval_ms)
    observability = Config.settings!().observability
    refresh_ms = refresh_ms_override || observability.refresh_ms
    render_interval_ms = render_interval_ms_override || observability.render_interval_ms
    render_fun = Keyword.get(opts, :render_fun, &render_to_terminal/1)
    dashboard_enabled = terminal_dashboard_enabled?()

    enabled =
      resolve_override(
        enabled_override,
        observability.dashboard_enabled and dashboard_enabled?() and dashboard_enabled
      )

    RenderScheduler.schedule_tick(refresh_ms, enabled)

    {:ok,
     %__MODULE__{
       refresh_ms: refresh_ms,
       enabled: enabled,
       render_interval_ms: render_interval_ms,
       refresh_ms_override: refresh_ms_override,
       enabled_override: enabled_override,
       render_interval_ms_override: render_interval_ms_override,
       render_fun: render_fun,
       token_samples: [],
       last_tps_second: nil,
       last_tps_value: nil,
       last_rendered_content: nil,
       last_rendered_at_ms: nil,
       pending_content: nil,
       flush_timer_ref: nil,
       last_snapshot_fingerprint: nil
     }}
  end

  @spec render_offline_status() :: :ok
  def render_offline_status do
    content =
      [
        Styling.colorize("╭─ SYMPHONY STATUS", Styling.ansi_bold()),
        Styling.colorize("│ app_status=offline", Styling.ansi_red()),
        Styling.closing_border()
      ]
      |> Enum.join("\n")

    render_to_terminal(content)
    :ok
  rescue
    error in [ArgumentError, RuntimeError] ->
      Logger.warning("Failed rendering offline status: #{Exception.message(error)}")
      :ok
  end

  @spec handle_info(term(), t()) :: {:noreply, t()}
  def handle_info(:tick, %{enabled: true} = state) do
    state = refresh_runtime_config(state)
    state = maybe_render(state)
    RenderScheduler.schedule_tick(state.refresh_ms, true)
    {:noreply, state}
  end

  def handle_info(:refresh, %{enabled: true} = state),
    do: {:noreply, maybe_render(refresh_runtime_config(state))}

  def handle_info(:refresh, state), do: {:noreply, state}

  def handle_info({:flush_render, timer_ref}, %{enabled: true, flush_timer_ref: timer_ref} = state) do
    now_ms = System.monotonic_time(:millisecond)

    state =
      case state.pending_content do
        nil ->
          %{state | flush_timer_ref: nil}

        content ->
          state
          |> Map.put(:flush_timer_ref, nil)
          |> Map.put(:pending_content, nil)
          |> RenderScheduler.render_content(content, now_ms)
      end

    {:noreply, state}
  end

  def handle_info({:flush_render, _timer_ref}, state), do: {:noreply, state}
  def handle_info(:tick, state), do: {:noreply, state}

  defp refresh_runtime_config(%__MODULE__{} = state) do
    observability = Config.settings!().observability

    %{
      state
      | enabled:
          resolve_override(
            state.enabled_override,
            observability.dashboard_enabled and dashboard_enabled?() and terminal_dashboard_enabled?()
          ),
        refresh_ms: state.refresh_ms_override || observability.refresh_ms,
        render_interval_ms: state.render_interval_ms_override || observability.render_interval_ms
    }
  end

  defp maybe_render(state) do
    now_ms = System.monotonic_time(:millisecond)
    {snapshot_data, token_samples} = snapshot_with_samples(state.token_samples, now_ms)
    state = Map.put(state, :token_samples, token_samples)

    current_tokens = SnapshotFormatter.snapshot_total_tokens(snapshot_data)

    {tps_second, tps} =
      throttled_tps(
        state.last_tps_second,
        state.last_tps_value,
        now_ms,
        token_samples,
        current_tokens
      )

    state =
      state
      |> Map.put(:last_tps_second, tps_second)
      |> Map.put(:last_tps_value, tps)

    if snapshot_data != state.last_snapshot_fingerprint or
         RenderScheduler.periodic_rerender_due?(state, now_ms) do
      content = SnapshotFormatter.format_snapshot_content(snapshot_data, tps)

      state
      |> maybe_update_snapshot_fingerprint(snapshot_data)
      |> RenderScheduler.maybe_enqueue_render(content, now_ms)
    else
      state
    end
  rescue
    error in [ArgumentError, RuntimeError] ->
      Logger.warning("Failed rendering status dashboard: #{Exception.message(error)}")
      state
  end

  defp maybe_update_snapshot_fingerprint(state, snapshot_data) do
    if snapshot_data == state.last_snapshot_fingerprint do
      state
    else
      Map.put(state, :last_snapshot_fingerprint, snapshot_data)
    end
  end

  defp snapshot_with_samples(token_samples, now_ms) do
    case snapshot_payload() do
      {:ok, %{running: running, retrying: retrying, codex_totals: codex_totals} = snapshot} ->
        total_tokens = Map.get(codex_totals, :total_tokens, 0)

        {
          {:ok,
           %{
             running: running,
             retrying: retrying,
             codex_totals: codex_totals,
             rate_limits: Map.get(snapshot, :rate_limits),
             polling: Map.get(snapshot, :polling)
           }},
          update_token_samples(token_samples, now_ms, total_tokens)
        }

      :error ->
        {
          :error,
          prune_samples(token_samples, now_ms)
        }
    end
  end

  defp snapshot_payload do
    if Process.whereis(Orchestrator) do
      case Orchestrator.snapshot() do
        %{
          running: running,
          retrying: retrying,
          codex_totals: codex_totals
        } = snapshot
        when is_list(running) and is_list(retrying) ->
          {:ok,
           %{
             running: running,
             retrying: retrying,
             codex_totals: codex_totals,
             rate_limits: Map.get(snapshot, :rate_limits),
             polling: Map.get(snapshot, :polling)
           }}

        _ ->
          :error
      end
    else
      :error
    end
  end

  defp update_token_samples(samples, now_ms, total_tokens) do
    SnapshotFormatter.prune_graph_samples([{now_ms, total_tokens} | samples], now_ms)
  end

  defp prune_samples(samples, now_ms) do
    min_timestamp = now_ms - @throughput_window_ms
    Enum.filter(samples, fn {timestamp, _} -> timestamp >= min_timestamp end)
  end

  defp render_to_terminal(content) do
    IO.write([
      IO.ANSI.home(),
      IO.ANSI.clear(),
      content,
      "\n"
    ])
  end

  @doc false
  @spec rolling_tps([{integer(), integer()}], integer(), integer()) :: float()
  def rolling_tps(samples, now_ms, current_tokens) do
    samples = [{now_ms, current_tokens} | samples]
    samples = prune_samples(samples, now_ms)

    case samples do
      [] ->
        0.0

      [_one] ->
        0.0

      _ ->
        first = List.last(samples)
        {start_ms, start_tokens} = first
        elapsed_ms = now_ms - start_ms
        delta_tokens = max(0, current_tokens - start_tokens)

        if elapsed_ms <= 0 do
          0.0
        else
          delta_tokens / (elapsed_ms / 1000.0)
        end
    end
  end

  @doc false
  @spec throttled_tps(integer() | nil, float() | nil, integer(), [{integer(), integer()}], integer()) ::
          {integer(), float()}
  def throttled_tps(last_second, last_value, now_ms, token_samples, current_tokens) do
    second = div(now_ms, 1000)

    if is_integer(last_second) and last_second == second and is_number(last_value) do
      {second, last_value}
    else
      {second, rolling_tps(token_samples, now_ms, current_tokens)}
    end
  end

  @doc false
  @spec format_timestamp_for_test(DateTime.t()) :: String.t()
  def format_timestamp_for_test(%DateTime{} = datetime), do: SnapshotFormatter.format_timestamp(datetime)

  @doc false
  @spec format_snapshot_content_for_test(term(), number()) :: String.t()
  def format_snapshot_content_for_test(snapshot_data, tps),
    do: SnapshotFormatter.format_snapshot_content(snapshot_data, tps)

  @doc false
  @spec format_snapshot_content_for_test(term(), number(), integer() | nil) :: String.t()
  def format_snapshot_content_for_test(snapshot_data, tps, terminal_columns),
    do: SnapshotFormatter.format_snapshot_content(snapshot_data, tps, terminal_columns)

  @doc false
  @spec dashboard_url_for_test(String.t(), non_neg_integer() | nil, non_neg_integer() | nil) ::
          String.t() | nil
  def dashboard_url_for_test(host, configured_port, bound_port),
    do: SnapshotFormatter.dashboard_url(host, configured_port, bound_port)

  @doc false
  @spec terminal_dashboard_output_enabled_for_test() :: boolean()
  def terminal_dashboard_output_enabled_for_test, do: terminal_dashboard_output_enabled?()

  @doc false
  @spec format_running_summary_for_test(map(), integer() | nil) :: String.t()
  def format_running_summary_for_test(running_entry, terminal_columns \\ nil),
    do: SnapshotFormatter.format_running_summary(running_entry, Styling.running_event_width(terminal_columns))

  @doc false
  @spec format_tps_for_test(number()) :: String.t()
  def format_tps_for_test(value), do: SnapshotFormatter.format_tps(value)

  @doc false
  @spec tps_graph_for_test([{integer(), integer()}], integer(), integer()) :: String.t()
  def tps_graph_for_test(samples, now_ms, current_tokens),
    do: SnapshotFormatter.tps_graph(samples, now_ms, current_tokens)

  @doc false
  @spec humanize_codex_message(term()) :: String.t()
  def humanize_codex_message(message), do: CodexMessage.humanize(message)

  defp dashboard_enabled? do
    if Code.ensure_loaded?(Mix) and function_exported?(Mix, :env, 0) do
      try do
        Mix.env() != :test
      rescue
        _ -> true
      end
    else
      true
    end
  end

  defp runtime_dashboard_enabled? do
    case Application.get_env(:symphony_elixir, :dashboard_enabled_override) do
      nil -> true
      value when is_boolean(value) -> value
      _ -> true
    end
  end

  defp terminal_dashboard_enabled? do
    runtime_dashboard_enabled?() and terminal_dashboard_output_enabled?()
  end

  defp terminal_dashboard_output_enabled? do
    case System.get_env("SYMPHONY_TERMINAL_DASHBOARD") do
      value when value in ["1", "true", "TRUE", "yes", "YES", "on", "ON"] ->
        true

      value when value in ["0", "false", "FALSE", "no", "NO", "off", "OFF"] ->
        false

      _ ->
        interactive_stdio?()
    end
  end

  defp interactive_stdio? do
    match?({:ok, columns} when is_integer(columns) and columns > 0, :io.columns(:stdio))
  rescue
    _ -> false
  catch
    _, _ -> false
  end

  defp keyword_override(opts, key) do
    if Keyword.has_key?(opts, key), do: Keyword.fetch!(opts, key), else: nil
  end

  defp resolve_override(nil, default), do: default
  defp resolve_override(override, _default), do: override
end
