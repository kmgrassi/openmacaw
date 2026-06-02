defmodule SymphonyElixir.StatusDashboard.RenderScheduler do
  @moduledoc """
  Throttle and interval logic that decides when the terminal dashboard
  should re-render and when an enqueued frame should flush.

  These helpers are split out so the dashboard root can stay focused on
  GenServer plumbing. They take the dashboard state map (or just the
  fields they need) and return either a decision boolean / delay or an
  updated state — they do not own state themselves.
  """

  require Logger

  @minimum_idle_rerender_ms 1_000

  @doc "Schedule the next periodic refresh tick when the dashboard is enabled."
  @spec schedule_tick(pos_integer(), boolean()) :: reference() | :ok
  def schedule_tick(refresh_ms, true), do: Process.send_after(self(), :tick, refresh_ms)
  def schedule_tick(_refresh_ms, false), do: :ok

  @doc """
  Decide whether the next computed frame should render immediately, be
  deduped, or be enqueued behind the throttle interval.
  """
  @spec maybe_enqueue_render(map(), String.t(), integer()) :: map()
  def maybe_enqueue_render(state, content, now_ms) do
    cond do
      content == state.last_rendered_content ->
        state

      render_now?(state, now_ms) ->
        render_content(state, content, now_ms)

      true ->
        schedule_flush_render(%{state | pending_content: content}, now_ms)
    end
  end

  @doc "Returns true if the dashboard should re-render even though the snapshot fingerprint is unchanged."
  @spec periodic_rerender_due?(map(), integer()) :: boolean()
  def periodic_rerender_due?(%{last_rendered_at_ms: nil}, _now_ms), do: true

  def periodic_rerender_due?(%{last_rendered_at_ms: last_rendered_at_ms}, now_ms)
      when is_integer(last_rendered_at_ms) do
    now_ms - last_rendered_at_ms >= @minimum_idle_rerender_ms
  end

  def periodic_rerender_due?(_state, _now_ms), do: false

  @doc "Returns true if we are past the throttle window and may render the next frame inline."
  @spec render_now?(map(), integer()) :: boolean()
  def render_now?(%{last_rendered_at_ms: nil, flush_timer_ref: nil}, _now_ms), do: true

  def render_now?(%{last_rendered_at_ms: last_rendered_at_ms, render_interval_ms: render_interval_ms}, now_ms)
      when is_integer(last_rendered_at_ms) and is_integer(render_interval_ms) do
    now_ms - last_rendered_at_ms >= render_interval_ms
  end

  def render_now?(_state, _now_ms), do: false

  @doc "Arm a flush timer to render the pending frame once the throttle interval expires."
  @spec schedule_flush_render(map(), integer()) :: map()
  def schedule_flush_render(%{flush_timer_ref: timer_ref} = state, _now_ms) when is_reference(timer_ref),
    do: state

  def schedule_flush_render(state, now_ms) do
    delay_ms = flush_delay_ms(state, now_ms)
    timer_ref = make_ref()
    Process.send_after(self(), {:flush_render, timer_ref}, delay_ms)
    %{state | flush_timer_ref: timer_ref}
  end

  @doc "Compute how long to wait before flushing the pending frame, in milliseconds."
  @spec flush_delay_ms(map(), integer()) :: pos_integer()
  def flush_delay_ms(%{last_rendered_at_ms: nil}, _now_ms), do: 1

  def flush_delay_ms(
        %{last_rendered_at_ms: last_rendered_at_ms, render_interval_ms: render_interval_ms},
        now_ms
      ) do
    remaining = render_interval_ms - (now_ms - last_rendered_at_ms)
    max(1, remaining)
  end

  @doc """
  Invoke the dashboard's `render_fun` with `content` and update the
  state's render bookkeeping. On render failure the state is left in a
  consistent (cleared) condition.
  """
  @spec render_content(map(), String.t(), integer()) :: map()
  def render_content(state, content, now_ms) do
    state.render_fun.(content)

    %{
      state
      | last_rendered_content: content,
        last_rendered_at_ms: now_ms,
        pending_content: nil,
        flush_timer_ref: nil
    }
  rescue
    error in [ArgumentError, RuntimeError] ->
      Logger.warning("Failed rendering terminal dashboard frame: #{Exception.message(error)}")
      %{state | pending_content: nil, flush_timer_ref: nil}
  end
end
