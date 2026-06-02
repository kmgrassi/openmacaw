defmodule SymphonyElixir.StatusDashboard.CodexMessage.OutputFormatting do
  @moduledoc false

  alias SymphonyElixir.StatusDashboard.CodexMessage.PayloadExtraction

  import PayloadExtraction, only: [extract_first_path: 2, map_path: 2, map_value: 2]

  @spec humanize_payload(term()) :: String.t()
  def humanize_payload(%{} = payload) do
    case map_value(payload, ["method", :method]) do
      method when is_binary(method) ->
        SymphonyElixir.StatusDashboard.CodexMessage.humanize_method(method, payload)

      _ ->
        cond do
          is_binary(map_value(payload, ["session_id", :session_id])) ->
            "session started (#{map_value(payload, ["session_id", :session_id])})"

          match?(%{"error" => _}, payload) ->
            "error: #{format_error_value(Map.get(payload, "error"))}"

          true ->
            payload
            |> inspect(pretty: true, limit: 30)
            |> String.replace("\n", " ")
            |> sanitize_ansi_and_control_bytes()
            |> String.trim()
        end
    end
  end

  def humanize_payload(payload) when is_binary(payload) do
    payload
    |> String.replace("\n", " ")
    |> sanitize_ansi_and_control_bytes()
    |> String.trim()
  end

  def humanize_payload(payload) do
    payload
    |> inspect(pretty: true, limit: 20)
    |> String.replace("\n", " ")
    |> sanitize_ansi_and_control_bytes()
    |> String.trim()
  end

  @spec sanitize_ansi_and_control_bytes(String.t()) :: String.t()
  def sanitize_ansi_and_control_bytes(value) when is_binary(value) do
    value
    |> String.replace(~r/\x1B\[[0-9;]*[A-Za-z]/, "")
    |> String.replace(~r/\x1B./, "")
    |> String.replace(~r/[\x00-\x1F\x7F]/, "")
  end

  @spec humanize_dynamic_tool_event(String.t(), term()) :: String.t()
  def humanize_dynamic_tool_event(base, payload) do
    case dynamic_tool_name(payload) do
      tool when is_binary(tool) ->
        trimmed = String.trim(tool)

        if trimmed == "" do
          base
        else
          "#{base} (#{trimmed})"
        end

      _ ->
        base
    end
  end

  @spec dynamic_tool_name(term()) :: term() | nil
  def dynamic_tool_name(payload) do
    map_path(payload, ["params", "tool"]) ||
      map_path(payload, ["params", "name"]) ||
      map_path(payload, [:params, :tool]) ||
      map_path(payload, [:params, :name])
  end

  @spec format_usage_counts(term()) :: String.t() | nil
  def format_usage_counts(usage) when is_map(usage) do
    input =
      parse_integer(
        map_value(usage, [
          "input_tokens",
          :input_tokens,
          "prompt_tokens",
          :prompt_tokens,
          "inputTokens",
          :inputTokens,
          "promptTokens",
          :promptTokens
        ])
      )

    output =
      parse_integer(
        map_value(usage, [
          "output_tokens",
          :output_tokens,
          "completion_tokens",
          :completion_tokens,
          "outputTokens",
          :outputTokens,
          "completionTokens",
          :completionTokens
        ])
      )

    total =
      parse_integer(
        map_value(usage, [
          "total_tokens",
          :total_tokens,
          "total",
          :total,
          "totalTokens",
          :totalTokens
        ])
      )

    parts =
      []
      |> append_usage_part("in", input)
      |> append_usage_part("out", output)
      |> append_usage_part("total", total)

    case parts do
      [] -> nil
      _ -> Enum.join(parts, ", ")
    end
  end

  def format_usage_counts(_usage), do: nil

  @spec format_rate_limits_summary(term()) :: String.t()
  def format_rate_limits_summary(nil), do: "n/a"

  def format_rate_limits_summary(rate_limits) when is_map(rate_limits) do
    primary = map_value(rate_limits, ["primary", :primary])
    secondary = map_value(rate_limits, ["secondary", :secondary])

    primary_text = format_rate_limit_bucket_summary(primary)
    secondary_text = format_rate_limit_bucket_summary(secondary)

    cond do
      primary_text != nil and secondary_text != nil -> "primary #{primary_text}; secondary #{secondary_text}"
      primary_text != nil -> "primary #{primary_text}"
      secondary_text != nil -> "secondary #{secondary_text}"
      true -> "n/a"
    end
  end

  def format_rate_limits_summary(_rate_limits), do: "n/a"

  @spec format_error_value(term()) :: String.t()
  def format_error_value(%{"message" => message}) when is_binary(message), do: message
  def format_error_value(%{message: message}) when is_binary(message), do: message
  def format_error_value(error), do: inspect(error, limit: 10)

  @spec format_reason(term()) :: String.t()
  def format_reason(message) when is_map(message) do
    case map_value(message, ["reason", :reason]) do
      nil ->
        message
        |> inspect(limit: 10)
        |> inline_text()

      reason ->
        format_error_value(reason)
    end
  end

  def format_reason(other), do: format_error_value(other)

  @spec humanize_streaming_event(String.t(), term()) :: String.t()
  def humanize_streaming_event(label, payload) do
    case extract_delta_preview(payload) do
      nil -> label
      preview -> "#{label}: #{preview}"
    end
  end

  @spec humanize_reasoning_update(term()) :: String.t()
  def humanize_reasoning_update(payload) do
    case extract_reasoning_focus(payload) do
      nil -> "reasoning update"
      focus -> "reasoning update: #{focus}"
    end
  end

  @spec extract_command(term()) :: String.t() | nil
  def extract_command(payload) do
    payload
    |> map_path(["params", "parsedCmd"])
    |> fallback_command(payload)
    |> normalize_command()
  end

  @spec normalize_command(term()) :: String.t() | nil
  def normalize_command(%{} = command) do
    binary_command = map_value(command, ["parsedCmd", :parsedCmd, "command", :command, "cmd", :cmd])
    args = map_value(command, ["args", :args, "argv", :argv])

    if is_binary(binary_command) and is_list(args) do
      normalize_command([binary_command | args])
    else
      normalize_command(binary_command || args)
    end
  end

  def normalize_command(command) when is_binary(command), do: inline_text(command)

  def normalize_command(command) when is_list(command) do
    if Enum.all?(command, &is_binary/1) do
      command
      |> Enum.join(" ")
      |> inline_text()
    else
      nil
    end
  end

  def normalize_command(_command), do: nil

  @spec humanize_item_type(term()) :: String.t()
  def humanize_item_type(nil), do: "item"

  def humanize_item_type(type) when is_binary(type) do
    type
    |> String.replace(~r/([a-z0-9])([A-Z])/, "\\1 \\2")
    |> String.replace("_", " ")
    |> String.replace("/", " ")
    |> String.downcase()
    |> String.trim()
  end

  def humanize_item_type(type), do: to_string(type)

  @spec humanize_status(term()) :: String.t() | nil
  def humanize_status(status) when is_binary(status) do
    status
    |> String.replace("_", " ")
    |> String.replace("-", " ")
    |> String.downcase()
    |> String.trim()
  end

  def humanize_status(_status), do: nil

  @spec short_id(term()) :: String.t() | nil
  def short_id(id) when is_binary(id) and byte_size(id) > 12, do: String.slice(id, 0, 12)
  def short_id(id) when is_binary(id), do: id
  def short_id(_id), do: nil

  @spec append_if_present([String.t()], term()) :: [String.t()]
  def append_if_present(list, value) when is_binary(value) and value != "", do: list ++ [value]
  def append_if_present(list, _value), do: list

  @spec wrapper_payload_type(term()) :: term() | nil
  def wrapper_payload_type(payload) do
    map_path(payload, ["params", "msg", "payload", "type"]) ||
      map_path(payload, [:params, :msg, :payload, :type])
  end

  @spec inline_text(term()) :: String.t()
  def inline_text(text) when is_binary(text) do
    text
    |> String.replace("\n", " ")
    |> String.replace(~r/\s+/, " ")
    |> String.trim()
    |> truncate(80)
  end

  def inline_text(other), do: other |> to_string() |> inline_text()

  @spec token_usage_paths() :: [[term()]]
  def token_usage_paths do
    [
      ["params", "msg", "payload", "info", "total_token_usage"],
      [:params, :msg, :payload, :info, :total_token_usage],
      ["params", "msg", "info", "total_token_usage"],
      [:params, :msg, :info, :total_token_usage],
      ["params", "tokenUsage", "total"],
      [:params, :tokenUsage, :total]
    ]
  end

  @spec truncate(String.t(), non_neg_integer()) :: String.t()
  def truncate(value, max) when byte_size(value) > max do
    value |> String.slice(0, max) |> Kernel.<>("...")
  end

  def truncate(value, _max), do: value

  defp append_usage_part(parts, _label, value) when not is_integer(value), do: parts
  defp append_usage_part(parts, label, value), do: parts ++ ["#{label} #{format_count(value)}"]

  defp format_rate_limit_bucket_summary(bucket) when is_map(bucket) do
    used_percent = map_value(bucket, ["usedPercent", :usedPercent])
    window_mins = map_value(bucket, ["windowDurationMins", :windowDurationMins])

    cond do
      is_number(used_percent) and is_integer(window_mins) ->
        "#{used_percent}% / #{window_mins}m"

      is_number(used_percent) ->
        "#{used_percent}% used"

      true ->
        nil
    end
  end

  defp format_rate_limit_bucket_summary(_bucket), do: nil

  defp extract_reasoning_focus(payload) do
    value = extract_first_path(payload, reasoning_focus_paths())

    if is_binary(value) do
      trimmed = String.trim(value)
      if trimmed == "", do: nil, else: inline_text(trimmed)
    else
      nil
    end
  end

  defp extract_delta_preview(payload) do
    delta = extract_first_path(payload, delta_paths())

    case delta do
      value when is_binary(value) ->
        trimmed = String.trim(value)
        if trimmed == "", do: nil, else: inline_text(trimmed)

      _ ->
        nil
    end
  end

  defp fallback_command(nil, payload) do
    map_path(payload, ["params", "command"]) ||
      map_path(payload, ["params", "cmd"]) ||
      map_path(payload, ["params", "argv"]) ||
      map_path(payload, ["params", "args"])
  end

  defp fallback_command(command, _payload), do: command

  defp parse_integer(value) when is_integer(value), do: value

  defp parse_integer(value) when is_binary(value) do
    case Integer.parse(String.trim(value)) do
      {parsed, ""} -> parsed
      _ -> nil
    end
  end

  defp parse_integer(_value), do: nil

  defp delta_paths do
    [
      ["params", "delta"],
      [:params, :delta],
      ["params", "msg", "delta"],
      [:params, :msg, :delta],
      ["params", "textDelta"],
      [:params, :textDelta],
      ["params", "msg", "textDelta"],
      [:params, :msg, :textDelta],
      ["params", "outputDelta"],
      [:params, :outputDelta],
      ["params", "msg", "outputDelta"],
      [:params, :msg, :outputDelta],
      ["params", "text"],
      [:params, :text],
      ["params", "msg", "text"],
      [:params, :msg, :text],
      ["params", "summaryText"],
      [:params, :summaryText],
      ["params", "msg", "summaryText"],
      [:params, :msg, :summaryText],
      ["params", "msg", "content"],
      [:params, :msg, :content],
      ["params", "msg", "payload", "delta"],
      [:params, :msg, :payload, :delta],
      ["params", "msg", "payload", "textDelta"],
      [:params, :msg, :payload, :textDelta],
      ["params", "msg", "payload", "outputDelta"],
      [:params, :msg, :payload, :outputDelta],
      ["params", "msg", "payload", "text"],
      [:params, :msg, :payload, :text],
      ["params", "msg", "payload", "summaryText"],
      [:params, :msg, :payload, :summaryText],
      ["params", "msg", "payload", "content"],
      [:params, :msg, :payload, :content]
    ]
  end

  defp reasoning_focus_paths do
    [
      ["params", "reason"],
      [:params, :reason],
      ["params", "summaryText"],
      [:params, :summaryText],
      ["params", "summary"],
      [:params, :summary],
      ["params", "text"],
      [:params, :text],
      ["params", "msg", "reason"],
      [:params, :msg, :reason],
      ["params", "msg", "summaryText"],
      [:params, :msg, :summaryText],
      ["params", "msg", "summary"],
      [:params, :msg, :summary],
      ["params", "msg", "text"],
      [:params, :msg, :text],
      ["params", "msg", "payload", "reason"],
      [:params, :msg, :payload, :reason],
      ["params", "msg", "payload", "summaryText"],
      [:params, :msg, :payload, :summaryText],
      ["params", "msg", "payload", "summary"],
      [:params, :msg, :payload, :summary],
      ["params", "msg", "payload", "text"],
      [:params, :msg, :payload, :text]
    ]
  end

  defp format_count(nil), do: "0"

  defp format_count(value) when is_integer(value) do
    value
    |> Integer.to_string()
    |> group_thousands()
  end

  defp group_thousands(value) when is_binary(value) do
    value
    |> String.reverse()
    |> String.replace(~r/(.{3})/, "\\1,")
    |> String.reverse()
    |> String.trim_leading(",")
  end
end
