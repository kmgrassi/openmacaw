defmodule SymphonyElixir.MessageHistory do
  @moduledoc """
  Fetches prior persisted agent messages for replay into the model
  request. The write side is `SymphonyElixir.ChatGateway`; this is the
  read counterpart.

  Returns `user` and `assistant` messages for OpenAI-compatible chat history.
  When persisted `tool_call` rows are available, complete assistant/tool
  pairs are replayed. Incomplete pairs are dropped because an assistant
  tool call without the matching tool result is invalid provider history.

  Should never raise: returns `[]` on any failure so a chat turn never
  fails because history is unavailable.
  """

  require Logger

  alias SymphonyElixir.MessageLog

  @default_limit 10
  @max_limit 50
  @default_max_tool_output_bytes 16_384
  @max_speaker_label_bytes 120
  # Fetch a small extra batch and filter client-side: we always need to
  # drop the current run's user message (already written by ChatGateway
  # before the turn reaches the model), and failure rows we want to skip.
  @overfetch 5

  @type message :: %{required(String.t()) => String.t()}

  @doc """
  Returns up to `limit` prior chat messages (user + assistant text only)
  for the agent in `scope`, ordered oldest → newest.

    * `:limit` — max messages to return; default #{@default_limit}, clamped to #{@max_limit}.
      Non-positive disables history (returns `[]`).
    * `:exclude_run_id` — skip messages whose `run_id` matches; use this
      to drop the in-flight user row that `ChatGateway.post_message/3`
      writes before the model is called.
    * `:max_tool_output_bytes` — per-tool replay content cap; default
      #{@default_max_tool_output_bytes}. Oversized outputs are truncated
      before being sent back to the model.
  """
  @spec fetch(map() | nil, keyword()) :: [message()]
  def fetch(scope, opts \\ [])

  def fetch(nil, _opts), do: []

  def fetch(scope, opts) when is_map(scope) and is_list(opts) do
    agent_id = Map.get(scope, :agent_id) || Map.get(scope, "agent_id")
    workspace_id = Map.get(scope, :workspace_id) || Map.get(scope, "workspace_id")
    session_thread_id = Map.get(scope, :session_thread_id) || Map.get(scope, "session_thread_id")

    limit = clamp_limit(Keyword.get(opts, :limit, @default_limit))
    exclude_run_id = Keyword.get(opts, :exclude_run_id)

    cond do
      not is_binary(agent_id) or agent_id == "" ->
        []

      limit <= 0 ->
        []

      true ->
        do_fetch(agent_id, workspace_id, session_thread_id, limit, exclude_run_id, Keyword.get(opts, :max_tool_output_bytes))
    end
  end

  def fetch(_scope, _opts), do: []

  defp do_fetch(agent_id, workspace_id, session_thread_id, limit, exclude_run_id, max_tool_output_bytes_opt) do
    fetch_limit = limit + @overfetch

    list_opts =
      [limit: fetch_limit]
      |> maybe_put(:workspace_id, workspace_id)
      |> maybe_put(:session_id, session_thread_id)
      |> Keyword.put(:include_tool_calls, true)

    case adapter().list_agent_messages(agent_id, list_opts) do
      {:ok, rows, _pagination} when is_list(rows) ->
        max_tool_output_bytes = max_tool_output_bytes(max_tool_output_bytes_opt)

        rows
        |> Enum.reject(&exclude?(&1, exclude_run_id))
        |> Enum.reverse()
        |> Enum.map(&to_message_group(&1, max_tool_output_bytes))
        |> Enum.reject(&Enum.empty?/1)
        |> take_groups_with_message_limit(limit)
        |> List.flatten()

      :disabled ->
        []

      {:error, reason} ->
        Logger.warning("agent message history fetch failed agent_id=#{agent_id} reason=#{inspect(reason)}")
        []

      other ->
        Logger.warning("agent message history fetch unexpected response agent_id=#{agent_id} response=#{inspect(other)}")
        []
    end
  end

  defp exclude?(row, exclude_run_id) when is_map(row) and is_binary(exclude_run_id) do
    Map.get(row, "run_id") == exclude_run_id
  end

  defp exclude?(_row, _exclude_run_id), do: false

  defp to_message_group(%{"role" => "user", "content" => content} = row, _max_tool_output_bytes)
       when is_binary(content) and content != "" do
    [%{"role" => "user", "content" => user_content(content, speaker_label(row))}]
  end

  defp to_message_group(%{"role" => "assistant"} = row, max_tool_output_bytes) do
    calls =
      row
      |> Map.get("tool_calls", [])
      |> Enum.map(&tool_call_pair(&1, max_tool_output_bytes))
      |> Enum.reject(&is_nil/1)

    cond do
      calls != [] ->
        [assistant_tool_call_message(row, calls) | Enum.map(calls, &tool_result_message/1)]

      text_content?(Map.get(row, "content")) ->
        [%{"role" => "assistant", "content" => Map.get(row, "content")}]

      true ->
        []
    end
  end

  defp to_message_group(_row, _max_tool_output_bytes), do: []

  defp take_groups_with_message_limit(groups, limit) do
    groups
    |> Enum.reverse()
    |> Enum.reduce_while({[], 0}, fn group, {selected, count} ->
      group_size = length(group)

      cond do
        group_size > limit ->
          {:cont, {selected, count}}

        count + group_size > limit ->
          {:halt, {selected, count}}

        true ->
          {:cont, {[group | selected], count + group_size}}
      end
    end)
    |> elem(0)
  end

  defp assistant_tool_call_message(row, calls) do
    %{
      "role" => "assistant",
      "content" => Map.get(row, "content") || "",
      "tool_calls" =>
        Enum.map(calls, fn call ->
          %{
            "id" => call.call_id,
            "type" => "function",
            "function" => %{"name" => call.tool_name, "arguments" => call.arguments}
          }
        end)
    }
  end

  defp tool_result_message(call) do
    %{
      "role" => "tool",
      "tool_call_id" => call.call_id,
      "content" => call.output
    }
  end

  defp tool_call_pair(%{"input" => input, "output" => output}, max_tool_output_bytes) do
    with {:ok, input_payload} <- decode_payload(input),
         {:ok, output_payload} <- decode_payload(output),
         call_id when is_binary(call_id) and call_id != "" <- call_id(input_payload),
         tool_name when is_binary(tool_name) and tool_name != "" <- tool_name(input_payload),
         {:ok, output_content} <- output_content(output_payload, max_tool_output_bytes) do
      %{
        call_id: call_id,
        tool_name: tool_name,
        arguments: arguments(input_payload),
        output: output_content
      }
    else
      _ -> nil
    end
  end

  defp tool_call_pair(_row, _max_tool_output_bytes), do: nil

  defp decode_payload(value) when is_binary(value) and value != "" do
    case Jason.decode(value) do
      {:ok, decoded} when is_map(decoded) -> {:ok, decoded}
      _ -> :error
    end
  end

  defp decode_payload(value) when is_map(value), do: {:ok, value}
  defp decode_payload(_value), do: :error

  defp call_id(payload) do
    Map.get(payload, "call_id") || get_in(payload, ["input", "id"]) ||
      get_in(payload, ["input", "call_id"])
  end

  defp tool_name(payload) do
    Map.get(payload, "tool_name") || get_in(payload, ["input", "name"]) ||
      get_in(payload, ["input", "tool_name"])
  end

  defp arguments(payload) do
    case get_in(payload, ["input", "arguments"]) do
      value when is_binary(value) -> value
      value when is_map(value) or is_list(value) -> Jason.encode!(value)
      _ -> "{}"
    end
  end

  defp output_content(payload, max_tool_output_bytes) do
    cond do
      Map.has_key?(payload, "output") ->
        {:ok, payload |> Map.get("output") |> encoded_content() |> truncate_content(max_tool_output_bytes)}

      Map.has_key?(payload, "status") ->
        {:ok, payload |> encoded_content() |> truncate_content(max_tool_output_bytes)}

      true ->
        :error
    end
  end

  defp encoded_content(value) when is_binary(value), do: value
  defp encoded_content(value), do: Jason.encode!(value)

  defp truncate_content(content, max_bytes) when byte_size(content) <= max_bytes, do: content

  defp truncate_content(content, max_bytes) do
    keep_bytes = max(max_bytes - byte_size("\n[tool output truncated for history replay]"), 0)
    binary_part(content, 0, safe_binary_prefix_size(content, keep_bytes)) <> "\n[tool output truncated for history replay]"
  end

  defp safe_binary_prefix_size(_content, keep_bytes) when keep_bytes <= 0, do: 0

  defp safe_binary_prefix_size(content, keep_bytes) do
    content
    |> binary_part(0, min(byte_size(content), keep_bytes))
    |> String.replace(~r/.[\x{80}-\x{BF}]*$/u, "")
    |> byte_size()
  rescue
    _ -> keep_bytes
  end

  defp text_content?(content), do: is_binary(content) and content != ""

  @doc false
  @spec user_content(String.t(), String.t() | nil) :: String.t()
  def user_content(content, speaker_label) when is_binary(content) do
    case clean_speaker_label(speaker_label) do
      nil -> content
      label -> "#{label} says:\n#{content}"
    end
  end

  @doc false
  @spec current_speaker_label(map() | nil) :: String.t() | nil
  def current_speaker_label(scope) when is_map(scope) do
    user_id = Map.get(scope, :user_id) || Map.get(scope, "user_id")

    cond do
      not is_binary(user_id) or user_id == "" ->
        nil

      function_exported?(adapter(), :resolve_user_display_names, 1) ->
        case adapter().resolve_user_display_names([user_id]) do
          {:ok, display_names} -> clean_speaker_label(Map.get(display_names, user_id))
          _other -> nil
        end

      true ->
        nil
    end
  end

  def current_speaker_label(_scope), do: nil

  defp speaker_label(row) do
    Map.get(row, "speaker_display_name") ||
      Map.get(row, "speakerDisplayName") ||
      Map.get(row, "user_id") ||
      Map.get(row, "userId")
  end

  defp clean_speaker_label(value) when is_binary(value) do
    value
    |> String.trim()
    |> String.replace(~r/\s+/, " ")
    |> truncate_label()
    |> case do
      "" -> nil
      label -> label
    end
  end

  defp clean_speaker_label(_value), do: nil

  defp truncate_label(value) when byte_size(value) <= @max_speaker_label_bytes, do: value

  defp truncate_label(value) do
    binary_part(value, 0, safe_binary_prefix_size(value, @max_speaker_label_bytes))
  end

  defp maybe_put(opts, _key, nil), do: opts
  defp maybe_put(opts, _key, ""), do: opts
  defp maybe_put(opts, key, value), do: Keyword.put(opts, key, value)

  defp clamp_limit(value) when is_integer(value) do
    cond do
      value <= 0 -> 0
      value > @max_limit -> @max_limit
      true -> value
    end
  end

  defp clamp_limit(value) when is_binary(value) do
    case Integer.parse(value) do
      {integer, ""} -> clamp_limit(integer)
      _ -> @default_limit
    end
  end

  defp clamp_limit(_value), do: @default_limit

  defp max_tool_output_bytes(value) when is_integer(value), do: max(value, 256)

  defp max_tool_output_bytes(value) when is_binary(value) do
    case Integer.parse(value) do
      {integer, ""} -> max_tool_output_bytes(integer)
      _ -> @default_max_tool_output_bytes
    end
  end

  defp max_tool_output_bytes(_value), do: @default_max_tool_output_bytes

  defp adapter, do: Application.get_env(:symphony_elixir, :message_log_adapter, MessageLog)

  @doc false
  def default_limit, do: @default_limit

  @doc false
  def max_limit, do: @max_limit
end
