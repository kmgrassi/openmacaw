defmodule SymphonyElixir.StatusDashboard.CodexMessage.ItemAndToolEvents do
  @moduledoc false

  alias SymphonyElixir.StatusDashboard.CodexMessage.{OutputFormatting, PayloadExtraction, RateLimitAndTokenEvents}

  import OutputFormatting,
    only: [
      append_if_present: 2,
      dynamic_tool_name: 1,
      extract_command: 1,
      humanize_dynamic_tool_event: 2,
      humanize_item_type: 1,
      humanize_reasoning_update: 1,
      humanize_status: 1,
      humanize_streaming_event: 2,
      inline_text: 1,
      normalize_command: 1,
      short_id: 1,
      wrapper_payload_type: 1
    ]

  import PayloadExtraction, only: [map_path: 2, map_value: 2]

  @spec humanize_event(atom(), term(), term()) :: String.t() | nil
  def humanize_event(:approval_auto_approved, message, payload) do
    method =
      map_value(payload, ["method", :method]) ||
        map_path(message, ["payload", "method"]) ||
        map_path(message, [:payload, :method])

    decision = map_value(message, ["decision", :decision])

    base =
      if is_binary(method) do
        "#{SymphonyElixir.StatusDashboard.CodexMessage.humanize_method(method, payload)} (auto-approved)"
      else
        "approval request auto-approved"
      end

    if is_binary(decision), do: "#{base}: #{decision}", else: base
  end

  def humanize_event(:tool_input_auto_answered, message, payload) do
    answer = map_value(message, ["answer", :answer])

    base =
      case humanize_method("item/tool/requestUserInput", payload) do
        nil -> "tool input auto-answered"
        text -> "#{text} (auto-answered)"
      end

    if is_binary(answer), do: "#{base}: #{inline_text(answer)}", else: base
  end

  def humanize_event(:tool_call_completed, _message, payload),
    do: humanize_dynamic_tool_event("dynamic tool call completed", payload)

  def humanize_event(:tool_call_failed, _message, payload),
    do: humanize_dynamic_tool_event("dynamic tool call failed", payload)

  def humanize_event(:unsupported_tool_call, _message, payload),
    do: humanize_dynamic_tool_event("unsupported dynamic tool call rejected", payload)

  def humanize_event(_event, _message, _payload), do: nil

  @spec humanize_method(String.t(), term()) :: String.t() | nil
  def humanize_method("item/started", payload), do: humanize_item_lifecycle("started", payload)
  def humanize_method("item/completed", payload), do: humanize_item_lifecycle("completed", payload)

  def humanize_method("item/agentMessage/delta", payload),
    do: humanize_streaming_event("agent message streaming", payload)

  def humanize_method("item/plan/delta", payload),
    do: humanize_streaming_event("plan streaming", payload)

  def humanize_method("item/reasoning/summaryTextDelta", payload),
    do: humanize_streaming_event("reasoning summary streaming", payload)

  def humanize_method("item/reasoning/summaryPartAdded", payload),
    do: humanize_streaming_event("reasoning summary section added", payload)

  def humanize_method("item/reasoning/textDelta", payload),
    do: humanize_streaming_event("reasoning text streaming", payload)

  def humanize_method("item/commandExecution/outputDelta", payload),
    do: humanize_streaming_event("command output streaming", payload)

  def humanize_method("item/fileChange/outputDelta", payload),
    do: humanize_streaming_event("file change output streaming", payload)

  def humanize_method("item/commandExecution/requestApproval", payload) do
    command = extract_command(payload)

    if is_binary(command) do
      "command approval requested (#{command})"
    else
      "command approval requested"
    end
  end

  def humanize_method("item/fileChange/requestApproval", payload) do
    change_count = map_path(payload, ["params", "fileChangeCount"]) || map_path(payload, ["params", "changeCount"])

    if is_integer(change_count) and change_count > 0 do
      "file change approval requested (#{change_count} files)"
    else
      "file change approval requested"
    end
  end

  def humanize_method("item/tool/requestUserInput", payload) do
    question =
      map_path(payload, ["params", "question"]) ||
        map_path(payload, ["params", "prompt"]) ||
        map_path(payload, [:params, :question]) ||
        map_path(payload, [:params, :prompt])

    if is_binary(question) and String.trim(question) != "" do
      "tool requires user input: #{inline_text(question)}"
    else
      "tool requires user input"
    end
  end

  def humanize_method("tool/requestUserInput", payload),
    do: humanize_method("item/tool/requestUserInput", payload)

  def humanize_method("account/updated", payload) do
    auth_mode =
      map_path(payload, ["params", "authMode"]) ||
        map_path(payload, [:params, :authMode]) ||
        "unknown"

    "account updated (auth #{auth_mode})"
  end

  def humanize_method("account/chatgptAuthTokens/refresh", _payload), do: "account auth token refresh requested"

  def humanize_method("item/tool/call", payload) do
    tool = dynamic_tool_name(payload)

    if is_binary(tool) and String.trim(tool) != "" do
      "dynamic tool call requested (#{tool})"
    else
      "dynamic tool call requested"
    end
  end

  def humanize_method(<<"codex/event/", suffix::binary>>, payload) do
    humanize_wrapper_event(suffix, payload)
  end

  def humanize_method(_method, _payload), do: nil

  defp humanize_item_lifecycle(state, payload) do
    item =
      map_path(payload, ["params", "item"]) ||
        map_path(payload, [:params, :item]) ||
        %{}

    item_type = item |> map_value(["type", :type]) |> humanize_item_type()
    item_status = map_value(item, ["status", :status])
    item_id = map_value(item, ["id", :id])

    details =
      []
      |> append_if_present(short_id(item_id))
      |> append_if_present(humanize_status(item_status))

    detail_suffix = if details == [], do: "", else: " (#{Enum.join(details, ", ")})"
    "item #{state}: #{item_type}#{detail_suffix}"
  end

  defp humanize_wrapper_event("mcp_startup_update", payload) do
    server =
      map_path(payload, ["params", "msg", "server"]) ||
        map_path(payload, [:params, :msg, :server]) ||
        "mcp"

    state =
      map_path(payload, ["params", "msg", "status", "state"]) ||
        map_path(payload, [:params, :msg, :status, :state]) ||
        "updated"

    "mcp startup: #{server} #{state}"
  end

  defp humanize_wrapper_event("mcp_startup_complete", _payload), do: "mcp startup complete"
  defp humanize_wrapper_event("task_started", _payload), do: "task started"
  defp humanize_wrapper_event("user_message", _payload), do: "user message received"

  defp humanize_wrapper_event("item_started", payload) do
    case wrapper_payload_type(payload) do
      "token_count" -> RateLimitAndTokenEvents.humanize_token_count(payload)
      type when is_binary(type) -> "item started (#{humanize_item_type(type)})"
      _ -> "item started"
    end
  end

  defp humanize_wrapper_event("item_completed", payload) do
    case wrapper_payload_type(payload) do
      "token_count" -> RateLimitAndTokenEvents.humanize_token_count(payload)
      type when is_binary(type) -> "item completed (#{humanize_item_type(type)})"
      _ -> "item completed"
    end
  end

  defp humanize_wrapper_event("agent_message_delta", payload),
    do: humanize_streaming_event("agent message streaming", payload)

  defp humanize_wrapper_event("agent_message_content_delta", payload),
    do: humanize_streaming_event("agent message content streaming", payload)

  defp humanize_wrapper_event("agent_reasoning_delta", payload),
    do: humanize_streaming_event("reasoning streaming", payload)

  defp humanize_wrapper_event("reasoning_content_delta", payload),
    do: humanize_streaming_event("reasoning content streaming", payload)

  defp humanize_wrapper_event("agent_reasoning_section_break", _payload), do: "reasoning section break"
  defp humanize_wrapper_event("agent_reasoning", payload), do: humanize_reasoning_update(payload)
  defp humanize_wrapper_event("turn_diff", _payload), do: "turn diff updated"
  defp humanize_wrapper_event("exec_command_begin", payload), do: humanize_exec_command_begin(payload)
  defp humanize_wrapper_event("exec_command_end", payload), do: humanize_exec_command_end(payload)
  defp humanize_wrapper_event("exec_command_output_delta", _payload), do: "command output streaming"
  defp humanize_wrapper_event("mcp_tool_call_begin", _payload), do: "mcp tool call started"
  defp humanize_wrapper_event("mcp_tool_call_end", _payload), do: "mcp tool call completed"
  defp humanize_wrapper_event("token_count", payload), do: RateLimitAndTokenEvents.humanize_token_count(payload)

  defp humanize_wrapper_event(other, payload) do
    msg_type =
      map_path(payload, ["params", "msg", "type"]) ||
        map_path(payload, [:params, :msg, :type])

    if is_binary(msg_type) do
      "#{other} (#{msg_type})"
    else
      other
    end
  end

  defp humanize_exec_command_begin(payload) do
    command =
      map_path(payload, ["params", "msg", "command"]) ||
        map_path(payload, [:params, :msg, :command]) ||
        map_path(payload, ["params", "msg", "parsed_cmd"]) ||
        map_path(payload, [:params, :msg, :parsed_cmd])

    command = normalize_command(command)

    if is_binary(command) do
      command
    else
      "command started"
    end
  end

  defp humanize_exec_command_end(payload) do
    exit_code =
      map_path(payload, ["params", "msg", "exit_code"]) ||
        map_path(payload, [:params, :msg, :exit_code]) ||
        map_path(payload, ["params", "msg", "exitCode"]) ||
        map_path(payload, [:params, :msg, :exitCode])

    if is_integer(exit_code) do
      "command completed (exit #{exit_code})"
    else
      "command completed"
    end
  end
end
