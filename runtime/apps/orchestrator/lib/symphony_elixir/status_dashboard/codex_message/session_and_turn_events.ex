defmodule SymphonyElixir.StatusDashboard.CodexMessage.SessionAndTurnEvents do
  @moduledoc false

  alias SymphonyElixir.StatusDashboard.CodexMessage.{OutputFormatting, PayloadExtraction}

  import OutputFormatting, only: [format_reason: 1, format_usage_counts: 1]
  import PayloadExtraction, only: [map_path: 2, map_value: 2]

  @spec humanize_event(atom(), term(), term()) :: String.t() | nil
  def humanize_event(:session_started, _message, payload) do
    session_id = map_value(payload, ["session_id", :session_id])

    if is_binary(session_id) do
      "session started (#{session_id})"
    else
      "session started"
    end
  end

  def humanize_event(:turn_input_required, _message, _payload), do: "turn blocked: waiting for user input"
  def humanize_event(:turn_ended_with_error, message, _payload), do: "turn ended with error: #{format_reason(message)}"
  def humanize_event(:startup_failed, message, _payload), do: "startup failed: #{format_reason(message)}"
  def humanize_event(:turn_failed, _message, payload), do: humanize_method("turn/failed", payload)
  def humanize_event(:turn_cancelled, _message, _payload), do: "turn cancelled"
  def humanize_event(:malformed, _message, _payload), do: "malformed JSON event from codex"
  def humanize_event(_event, _message, _payload), do: nil

  @spec humanize_method(String.t(), term()) :: String.t() | nil
  def humanize_method("thread/started", payload) do
    thread_id = map_path(payload, ["params", "thread", "id"]) || map_path(payload, [:params, :thread, :id])

    if is_binary(thread_id) do
      "thread started (#{thread_id})"
    else
      "thread started"
    end
  end

  def humanize_method("turn/started", payload) do
    turn_id = map_path(payload, ["params", "turn", "id"]) || map_path(payload, [:params, :turn, :id])

    if is_binary(turn_id) do
      "turn started (#{turn_id})"
    else
      "turn started"
    end
  end

  def humanize_method("turn/completed", payload) do
    status =
      map_path(payload, ["params", "turn", "status"]) ||
        map_path(payload, [:params, :turn, :status]) ||
        "completed"

    usage =
      map_path(payload, ["params", "usage"]) ||
        map_path(payload, [:params, :usage]) ||
        map_path(payload, ["params", "tokenUsage"]) ||
        map_path(payload, [:params, :tokenUsage]) ||
        map_value(payload, ["usage", :usage])

    usage_suffix =
      case format_usage_counts(usage) do
        nil -> ""
        usage_text -> " (#{usage_text})"
      end

    "turn completed (#{status})#{usage_suffix}"
  end

  def humanize_method("turn/failed", payload) do
    error_message =
      map_path(payload, ["params", "error", "message"]) ||
        map_path(payload, [:params, :error, :message])

    if is_binary(error_message), do: "turn failed: #{error_message}", else: "turn failed"
  end

  def humanize_method("turn/cancelled", _payload), do: "turn cancelled"

  def humanize_method("turn/diff/updated", payload) do
    diff =
      map_path(payload, ["params", "diff"]) ||
        map_path(payload, [:params, :diff]) ||
        ""

    if is_binary(diff) and diff != "" do
      line_count = diff |> String.split("\n", trim: true) |> length()
      "turn diff updated (#{line_count} lines)"
    else
      "turn diff updated"
    end
  end

  def humanize_method("turn/plan/updated", payload) do
    plan_entries =
      map_path(payload, ["params", "plan"]) ||
        map_path(payload, [:params, :plan]) ||
        map_path(payload, ["params", "steps"]) ||
        map_path(payload, [:params, :steps]) ||
        map_path(payload, ["params", "items"]) ||
        map_path(payload, [:params, :items]) ||
        []

    if is_list(plan_entries) do
      "plan updated (#{length(plan_entries)} steps)"
    else
      "plan updated"
    end
  end

  def humanize_method(_method, _payload), do: nil
end
