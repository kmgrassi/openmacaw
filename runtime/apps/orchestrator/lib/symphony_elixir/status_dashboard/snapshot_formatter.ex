defmodule SymphonyElixir.StatusDashboard.SnapshotFormatter do
  @moduledoc """
  Pure data-in / strings-out helpers that turn an orchestrator snapshot
  into the rendered dashboard frame.

  All functions here are side-effect free aside from reading
  `Config.settings!/0` for project metadata and the bound HTTP port.
  Styling primitives (ANSI codes, column widths, table chrome) live
  in `SymphonyElixir.StatusDashboard.Styling`.
  """

  alias SymphonyElixir.{Config, HttpServer}
  alias SymphonyElixir.StatusDashboard.{CodexMessage, Styling}

  @throughput_graph_window_ms 10 * 60 * 1000
  @throughput_graph_columns 24

  @spec format_snapshot_content(term(), number()) :: String.t()
  def format_snapshot_content(snapshot_data, tps), do: format_snapshot_content(snapshot_data, tps, nil)

  @spec format_snapshot_content(term(), number(), integer() | nil) :: String.t()
  def format_snapshot_content(snapshot_data, tps, terminal_columns_override) do
    case snapshot_data do
      {:ok, %{running: running, retrying: retrying, codex_totals: codex_totals} = snapshot} ->
        rate_limits = Map.get(snapshot, :rate_limits)
        project_link_lines = format_project_link_lines()
        project_refresh_line = format_project_refresh_line(Map.get(snapshot, :polling))
        codex_input_tokens = Map.get(codex_totals, :input_tokens, 0)
        codex_output_tokens = Map.get(codex_totals, :output_tokens, 0)
        codex_total_tokens = Map.get(codex_totals, :total_tokens, 0)
        codex_seconds_running = Map.get(codex_totals, :seconds_running, 0)
        agent_count = length(running)
        max_agents = effective_max_agents(snapshot)
        running_event_width = Styling.running_event_width(terminal_columns_override)
        running_rows = format_running_rows(running, running_event_width)
        running_to_backoff_spacer = if(running == [], do: [], else: ["│"])
        backoff_rows = format_retry_rows(retrying)

        ([
           Styling.colorize("╭─ SYMPHONY STATUS", Styling.ansi_bold()),
           Styling.colorize("│ Agents: ", Styling.ansi_bold()) <>
             Styling.colorize("#{agent_count}", Styling.ansi_green()) <>
             Styling.colorize("/", Styling.ansi_gray()) <>
             Styling.colorize("#{max_agents}", Styling.ansi_gray()),
           Styling.colorize("│ Throughput: ", Styling.ansi_bold()) <>
             Styling.colorize("#{format_tps(tps)} tps", Styling.ansi_cyan()),
           Styling.colorize("│ Runtime: ", Styling.ansi_bold()) <>
             Styling.colorize(format_runtime_seconds(codex_seconds_running), Styling.ansi_magenta()),
           Styling.colorize("│ Tokens: ", Styling.ansi_bold()) <>
             Styling.colorize("in #{format_count(codex_input_tokens)}", Styling.ansi_yellow()) <>
             Styling.colorize(" | ", Styling.ansi_gray()) <>
             Styling.colorize("out #{format_count(codex_output_tokens)}", Styling.ansi_yellow()) <>
             Styling.colorize(" | ", Styling.ansi_gray()) <>
             Styling.colorize("total #{format_count(codex_total_tokens)}", Styling.ansi_yellow()),
           Styling.colorize("│ Rate Limits: ", Styling.ansi_bold()) <> format_rate_limits(rate_limits),
           project_link_lines,
           project_refresh_line,
           Styling.colorize("├─ Running", Styling.ansi_bold()),
           "│",
           Styling.running_table_header_row(running_event_width),
           Styling.running_table_separator_row(running_event_width)
         ] ++
           running_rows ++
           running_to_backoff_spacer ++
           [Styling.colorize("├─ Backoff queue", Styling.ansi_bold()), "│"] ++
           backoff_rows ++
           [Styling.closing_border()])
        |> List.flatten()
        |> Enum.join("\n")

      :error ->
        [
          Styling.colorize("╭─ SYMPHONY STATUS", Styling.ansi_bold()),
          Styling.colorize("│ Orchestrator snapshot unavailable", Styling.ansi_red()),
          Styling.colorize("│ Throughput: ", Styling.ansi_bold()) <>
            Styling.colorize("#{format_tps(tps)} tps", Styling.ansi_cyan()),
          format_project_link_lines(),
          format_project_refresh_line(nil),
          Styling.closing_border()
        ]
        |> List.flatten()
        |> Enum.join("\n")
    end
  end

  @spec format_running_rows([map()], pos_integer()) :: [String.t()]
  def format_running_rows(running, running_event_width) do
    if running == [] do
      [
        "│  " <> Styling.colorize("No active agents", Styling.ansi_gray()),
        "│"
      ]
    else
      running
      |> Enum.sort_by(& &1.identifier)
      |> Enum.map(&format_running_summary(&1, running_event_width))
    end
  end

  # credo:disable-for-next-line
  @spec format_running_summary(map(), pos_integer()) :: String.t()
  def format_running_summary(running_entry, running_event_width) do
    issue = Styling.format_cell(running_entry.identifier || "unknown", Styling.running_id_width())
    state = running_entry.state || "unknown"
    state_display = Styling.format_cell(to_string(state), Styling.running_stage_width())

    session =
      running_entry.session_id
      |> compact_session_id()
      |> Styling.format_cell(Styling.running_session_width())

    pid = Styling.format_cell(running_entry.codex_app_server_pid || "n/a", Styling.running_pid_width())
    total_tokens = running_entry.codex_total_tokens || 0
    runtime_seconds = running_entry.runtime_seconds || 0
    turn_count = Map.get(running_entry, :turn_count, 0)

    age =
      Styling.format_cell(format_runtime_and_turns(runtime_seconds, turn_count), Styling.running_age_width())

    event = running_entry.last_codex_event || "none"
    event_label = Styling.format_cell(summarize_message(running_entry.last_codex_message), running_event_width)

    tokens =
      total_tokens
      |> format_count()
      |> Styling.format_cell(Styling.running_tokens_width(), :right)

    status_color =
      case event do
        :none -> Styling.ansi_red()
        "codex/event/token_count" -> Styling.ansi_yellow()
        "codex/event/task_started" -> Styling.ansi_green()
        "turn_completed" -> Styling.ansi_magenta()
        _ -> Styling.ansi_blue()
      end

    [
      "│ ",
      Styling.status_dot(status_color),
      " ",
      Styling.colorize(issue, Styling.ansi_cyan()),
      " ",
      Styling.colorize(state_display, status_color),
      " ",
      Styling.colorize(pid, Styling.ansi_yellow()),
      " ",
      Styling.colorize(age, Styling.ansi_magenta()),
      " ",
      Styling.colorize(tokens, Styling.ansi_yellow()),
      " ",
      Styling.colorize(session, Styling.ansi_cyan()),
      " ",
      Styling.colorize(event_label, status_color)
    ]
    |> Enum.join("")
  end

  @spec format_retry_rows([map()]) :: [String.t()]
  def format_retry_rows(retrying) do
    if retrying == [] do
      ["│  " <> Styling.colorize("No queued retries", Styling.ansi_gray())]
    else
      retrying
      |> Enum.sort_by(& &1.due_in_ms)
      |> Enum.map_join(", ", &format_retry_summary/1)
      |> String.split(", ")
    end
  end

  defp format_retry_summary(retry_entry) do
    issue_id = retry_entry.issue_id || "unknown"
    identifier = retry_entry.identifier || issue_id
    attempt = retry_entry.attempt || 0
    due_in_ms = retry_entry.due_in_ms || 0
    error = format_retry_error(retry_entry.error)

    "│  #{Styling.colorize("↻", Styling.ansi_orange())} " <>
      Styling.colorize("#{identifier}", Styling.ansi_red()) <>
      " " <>
      Styling.colorize("attempt=#{attempt}", Styling.ansi_yellow()) <>
      Styling.colorize(" in ", Styling.ansi_dim()) <>
      Styling.colorize(next_in_words(due_in_ms), Styling.ansi_cyan()) <>
      error
  end

  defp next_in_words(due_in_ms) when is_integer(due_in_ms) do
    secs = div(due_in_ms, 1000)
    millis = rem(due_in_ms, 1000)
    "#{secs}.#{String.pad_leading(to_string(millis), 3, "0")}s"
  end

  defp next_in_words(_), do: "n/a"

  defp format_retry_error(error) when is_binary(error) do
    sanitized =
      error
      |> String.replace("\\r\\n", " ")
      |> String.replace("\\r", " ")
      |> String.replace("\\n", " ")
      |> String.replace("\r\n", " ")
      |> String.replace("\r", " ")
      |> String.replace("\n", " ")
      |> String.replace(~r/\s+/, " ")
      |> String.trim()

    if sanitized == "" do
      ""
    else
      " " <> Styling.colorize("error=#{Styling.truncate(sanitized, 96)}", Styling.ansi_dim())
    end
  end

  defp format_retry_error(_), do: ""

  defp effective_max_agents(snapshot) when is_map(snapshot) do
    get_in(snapshot, [:capacity, :effective_max_concurrent_agents]) ||
      get_in(snapshot, ["capacity", "effective_max_concurrent_agents"]) ||
      Config.settings!().agent.max_concurrent_agents
  end

  defp effective_max_agents(_snapshot), do: Config.settings!().agent.max_concurrent_agents

  @spec format_runtime_seconds(integer() | binary() | term()) :: String.t()
  def format_runtime_seconds(seconds) when is_integer(seconds) do
    mins = div(seconds, 60)
    secs = rem(seconds, 60)
    "#{mins}m #{secs}s"
  end

  def format_runtime_seconds(seconds) when is_binary(seconds), do: seconds
  def format_runtime_seconds(_), do: "0m 0s"

  defp format_runtime_and_turns(seconds, turn_count) when is_integer(turn_count) and turn_count > 0 do
    "#{format_runtime_seconds(seconds)} / #{turn_count}"
  end

  defp format_runtime_and_turns(seconds, _turn_count), do: format_runtime_seconds(seconds)

  @spec format_count(term()) :: String.t()
  def format_count(nil), do: "0"

  def format_count(value) when is_integer(value) do
    value
    |> Integer.to_string()
    |> group_thousands()
  end

  def format_count(value) when is_binary(value) do
    value
    |> String.trim()
    |> Integer.parse()
    |> case do
      {number, ""} -> group_thousands(Integer.to_string(number))
      _ -> value
    end
  end

  def format_count(value), do: to_string(value)

  defp group_thousands(value) when is_binary(value) do
    sign = if String.starts_with?(value, "-"), do: "-", else: ""
    unsigned = if sign == "", do: value, else: String.slice(value, 1, String.length(value) - 1)

    unsigned
    |> String.reverse()
    |> String.replace(~r/(\d{3})(?=\d)/, "\\1,")
    |> String.reverse()
    |> prepend(sign)
  end

  defp prepend("", value), do: value
  defp prepend(prefix, value), do: prefix <> value

  @spec format_tps(number()) :: String.t()
  def format_tps(value) when is_number(value) do
    value
    |> trunc()
    |> Integer.to_string()
    |> group_thousands()
  end

  @spec format_project_link_lines() :: [String.t()]
  def format_project_link_lines do
    project_part =
      case Config.settings!().tracker.project_slug do
        project_slug when is_binary(project_slug) and project_slug != "" ->
          Styling.colorize(linear_project_url(project_slug), Styling.ansi_cyan())

        _ ->
          Styling.colorize("n/a", Styling.ansi_gray())
      end

    project_line = Styling.colorize("│ Project: ", Styling.ansi_bold()) <> project_part

    case dashboard_url() do
      url when is_binary(url) ->
        [project_line, Styling.colorize("│ Dashboard: ", Styling.ansi_bold()) <> Styling.colorize(url, Styling.ansi_cyan())]

      _ ->
        [project_line]
    end
  end

  @spec format_project_refresh_line(map() | nil) :: String.t()
  def format_project_refresh_line(%{checking?: true}) do
    Styling.colorize("│ Next refresh: ", Styling.ansi_bold()) <>
      Styling.colorize("checking now…", Styling.ansi_cyan())
  end

  def format_project_refresh_line(%{next_poll_in_ms: due_in_ms}) when is_integer(due_in_ms) do
    due_in_ms = max(due_in_ms, 0)
    seconds = div(due_in_ms + 999, 1000)
    Styling.colorize("│ Next refresh: ", Styling.ansi_bold()) <> Styling.colorize("#{seconds}s", Styling.ansi_cyan())
  end

  def format_project_refresh_line(_) do
    Styling.colorize("│ Next refresh: ", Styling.ansi_bold()) <> Styling.colorize("n/a", Styling.ansi_gray())
  end

  defp linear_project_url(project_slug), do: "https://linear.app/project/#{project_slug}/issues"

  @spec dashboard_url() :: String.t() | nil
  def dashboard_url do
    dashboard_url(Config.settings!().server.host, Config.server_port(), HttpServer.bound_port())
  end

  @spec dashboard_url(String.t(), non_neg_integer() | nil, non_neg_integer() | nil) :: String.t() | nil
  def dashboard_url(_host, nil, _bound_port), do: nil

  def dashboard_url(host, configured_port, bound_port) do
    port = bound_port || configured_port

    if is_integer(port) and port > 0 do
      "http://#{dashboard_url_host(host)}:#{port}/"
    else
      nil
    end
  end

  defp dashboard_url_host(host) when host in ["0.0.0.0", "::", "[::]", ""], do: "127.0.0.1"

  defp dashboard_url_host(host) when is_binary(host) do
    trimmed_host = String.trim(host)

    cond do
      trimmed_host in ["0.0.0.0", "::", "[::]", ""] ->
        "127.0.0.1"

      String.starts_with?(trimmed_host, "[") and String.ends_with?(trimmed_host, "]") ->
        trimmed_host

      String.contains?(trimmed_host, ":") ->
        "[#{trimmed_host}]"

      true ->
        trimmed_host
    end
  end

  @spec format_rate_limits(term()) :: String.t()
  def format_rate_limits(nil), do: Styling.colorize("unavailable", Styling.ansi_gray())

  def format_rate_limits(rate_limits) when is_map(rate_limits) do
    limit_id =
      map_value(rate_limits, ["limit_id", :limit_id, "limit_name", :limit_name]) ||
        "unknown"

    primary = format_rate_limit_bucket(map_value(rate_limits, ["primary", :primary]))
    secondary = format_rate_limit_bucket(map_value(rate_limits, ["secondary", :secondary]))
    credits = format_rate_limit_credits(map_value(rate_limits, ["credits", :credits]))

    Styling.colorize(to_string(limit_id), Styling.ansi_yellow()) <>
      Styling.colorize(" | ", Styling.ansi_gray()) <>
      Styling.colorize("primary #{primary}", Styling.ansi_cyan()) <>
      Styling.colorize(" | ", Styling.ansi_gray()) <>
      Styling.colorize("secondary #{secondary}", Styling.ansi_cyan()) <>
      Styling.colorize(" | ", Styling.ansi_gray()) <>
      Styling.colorize(credits, Styling.ansi_green())
  end

  def format_rate_limits(other) do
    other
    |> inspect(limit: 10)
    |> Styling.truncate(80)
    |> Styling.colorize(Styling.ansi_gray())
  end

  defp format_rate_limit_bucket(nil), do: "n/a"

  defp format_rate_limit_bucket(bucket) when is_map(bucket) do
    remaining = map_value(bucket, ["remaining", :remaining])
    limit = map_value(bucket, ["limit", :limit])

    reset_value =
      map_value(bucket, [
        "reset_in_seconds",
        :reset_in_seconds,
        "resetInSeconds",
        :resetInSeconds,
        "reset_at",
        :reset_at,
        "resetAt",
        :resetAt,
        "resets_at",
        :resets_at,
        "resetsAt",
        :resetsAt
      ])

    base =
      cond do
        integer_like?(remaining) and integer_like?(limit) ->
          "#{format_count(remaining)}/#{format_count(limit)}"

        integer_like?(remaining) ->
          "remaining #{format_count(remaining)}"

        integer_like?(limit) ->
          "limit #{format_count(limit)}"

        map_size(bucket) == 0 ->
          "n/a"

        true ->
          bucket |> inspect(limit: 6) |> Styling.truncate(40)
      end

    if is_nil(reset_value) do
      base
    else
      "#{base} reset #{format_reset_value(reset_value)}"
    end
  end

  defp format_rate_limit_bucket(other), do: to_string(other)

  defp format_rate_limit_credits(nil), do: "credits n/a"

  defp format_rate_limit_credits(credits) when is_map(credits) do
    unlimited = map_value(credits, ["unlimited", :unlimited]) == true
    has_credits = map_value(credits, ["has_credits", :has_credits]) == true
    balance = map_value(credits, ["balance", :balance])

    cond do
      unlimited ->
        "credits unlimited"

      has_credits and is_number(balance) ->
        "credits #{format_number(balance)}"

      has_credits ->
        "credits available"

      true ->
        "credits none"
    end
  end

  defp format_rate_limit_credits(other), do: "credits #{to_string(other)}"

  defp format_reset_value(value) when is_integer(value), do: "#{format_count(value)}s"
  defp format_reset_value(value) when is_binary(value), do: value
  defp format_reset_value(value), do: to_string(value)

  defp format_number(value) when is_integer(value), do: format_count(value)

  defp format_number(value) when is_float(value) do
    value
    |> Float.round(2)
    |> :erlang.float_to_binary(decimals: 2)
  end

  defp map_value(map, keys) when is_map(map) and is_list(keys) do
    Enum.find_value(keys, &Map.get(map, &1))
  end

  defp map_value(_map, _keys), do: nil

  defp integer_like?(value) when is_integer(value), do: true
  defp integer_like?(_value), do: false

  @spec compact_session_id(term()) :: String.t()
  def compact_session_id(nil), do: "n/a"
  def compact_session_id(session_id) when not is_binary(session_id), do: "n/a"

  def compact_session_id(session_id) do
    if String.length(session_id) > 10 do
      String.slice(session_id, 0, 4) <> "..." <> String.slice(session_id, -6, 6)
    else
      session_id
    end
  end

  @spec summarize_message(term()) :: String.t()
  def summarize_message(message), do: CodexMessage.humanize(message)

  @spec format_timestamp(DateTime.t()) :: String.t()
  def format_timestamp(%DateTime{} = datetime) do
    datetime
    |> DateTime.truncate(:second)
    |> DateTime.to_string()
  end

  @spec snapshot_total_tokens(term()) :: non_neg_integer()
  def snapshot_total_tokens({:ok, %{codex_totals: codex_totals}}) when is_map(codex_totals) do
    Map.get(codex_totals, :total_tokens, 0)
  end

  def snapshot_total_tokens(_snapshot_data), do: 0

  @spec tps_graph([{integer(), integer()}], integer(), integer()) :: String.t()
  def tps_graph(samples, now_ms, current_tokens) do
    bucket_ms = div(@throughput_graph_window_ms, @throughput_graph_columns)
    active_bucket_start = div(now_ms, bucket_ms) * bucket_ms
    graph_window_start = active_bucket_start - (@throughput_graph_columns - 1) * bucket_ms

    rates =
      [{now_ms, current_tokens} | samples]
      |> prune_graph_samples(now_ms)
      |> Enum.sort_by(&elem(&1, 0))
      |> Enum.chunk_every(2, 1, :discard)
      |> Enum.map(fn [{start_ms, start_tokens}, {end_ms, end_tokens}] ->
        elapsed_ms = end_ms - start_ms
        delta_tokens = max(0, end_tokens - start_tokens)
        tps = if elapsed_ms <= 0, do: 0.0, else: delta_tokens / (elapsed_ms / 1000.0)
        {end_ms, tps}
      end)

    bucketed_tps =
      0..(@throughput_graph_columns - 1)
      |> Enum.map(fn bucket_idx ->
        bucket_start = graph_window_start + bucket_idx * bucket_ms
        bucket_end = bucket_start + bucket_ms
        last_bucket? = bucket_idx == @throughput_graph_columns - 1

        values =
          rates
          |> Enum.filter(fn {timestamp, _tps} ->
            in_bucket?(timestamp, bucket_start, bucket_end, last_bucket?)
          end)
          |> Enum.map(fn {_timestamp, tps} -> tps end)

        if values == [] do
          0.0
        else
          Enum.sum(values) / length(values)
        end
      end)

    blocks = Styling.sparkline_blocks()
    max_tps = Enum.max(bucketed_tps, fn -> 0.0 end)

    bucketed_tps
    |> Enum.map_join(fn value ->
      index =
        if max_tps <= 0 do
          0
        else
          round(value / max_tps * (length(blocks) - 1))
        end

      Enum.at(blocks, index, "▁")
    end)
  end

  @spec prune_graph_samples([{integer(), integer()}], integer()) :: [{integer(), integer()}]
  def prune_graph_samples(samples, now_ms) do
    min_timestamp = now_ms - @throughput_graph_window_ms
    Enum.filter(samples, fn {timestamp, _} -> timestamp >= min_timestamp end)
  end

  defp in_bucket?(timestamp, bucket_start, bucket_end, true),
    do: timestamp >= bucket_start and timestamp <= bucket_end

  defp in_bucket?(timestamp, bucket_start, bucket_end, false),
    do: timestamp >= bucket_start and timestamp < bucket_end
end
