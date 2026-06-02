defmodule SymphonyElixir.ToolAdapter.PromptBased do
  @moduledoc "Prompt-based JSON tool-call adapter for models without native tool calls."

  @behaviour SymphonyElixir.ToolAdapter

  alias SymphonyElixir.ToolCall

  @name_pattern ~r/^[a-z][a-z0-9_.]{0,62}$/

  @impl true
  def to_tool_specs(_tools), do: []

  @impl true
  def parse_tool_calls(%{"output_text" => text}) when is_binary(text), do: parse_text(text)
  def parse_tool_calls(%{output_text: text}) when is_binary(text), do: parse_text(text)
  def parse_tool_calls(%{"content" => text}) when is_binary(text), do: parse_text(text)
  def parse_tool_calls(%{content: text}) when is_binary(text), do: parse_text(text)
  def parse_tool_calls(_response), do: []

  @impl true
  def format_tool_result(tool_call_id, result) do
    %{
      "role" => "tool",
      "tool_call_id" => tool_call_id,
      "content" => result_output(result)
    }
  end

  @doc "Parse a single prompt-based call from model text."
  @spec parse_tool_call(String.t()) :: {:ok, map()} | :no_tool_call
  def parse_tool_call(text) when is_binary(text) do
    case parse_text(text) do
      [call | _] -> {:ok, %{"name" => call.name, "arguments" => call.arguments}}
      [] -> :no_tool_call
    end
  end

  def parse_tool_call(_text), do: :no_tool_call

  defp parse_text(text) do
    parse_json_text(text) || parse_tagged_text(text) || []
  end

  defp parse_json_text(text) do
    text
    |> candidate_json_strings()
    |> Enum.find_value(fn candidate ->
      case decode_tool_call(candidate) do
        {:ok, tool_call} -> [tool_call]
        :no_tool_call -> nil
      end
    end)
  end

  defp decode_tool_call(candidate) do
    with {:ok, decoded} <- Jason.decode(candidate),
         {:ok, tool_call} <- normalize_tool_call(decoded) do
      {:ok, tool_call}
    else
      _ -> :no_tool_call
    end
  end

  defp normalize_tool_call(%{"tool_call" => tool_call}) when is_map(tool_call), do: normalize_tool_call(tool_call)

  defp normalize_tool_call(%{"name" => name, "arguments" => arguments})
       when is_binary(name) and is_map(arguments) do
    if Regex.match?(@name_pattern, name) do
      {:ok, ToolCall.new(%{id: "call_1", name: name, arguments: arguments, raw_arguments: arguments})}
    else
      :error
    end
  end

  defp normalize_tool_call(_decoded), do: :error

  defp parse_tagged_text(text) do
    case Regex.run(~r/<function=([A-Za-z0-9_.-]+)>\s*(.*?)\s*<\/function>/s, text, capture: :all_but_first) do
      [name, body] ->
        arguments =
          ~r/<parameter=([A-Za-z0-9_.-]+)>\s*(.*?)\s*<\/parameter>/s
          |> Regex.scan(body, capture: :all_but_first)
          |> Map.new(fn [key, value] -> {key, tagged_value(value)} end)

        case normalize_tool_call(%{"name" => name, "arguments" => arguments}) do
          {:ok, tool_call} -> [tool_call]
          :error -> nil
        end

      _ ->
        nil
    end
  end

  defp tagged_value(value) do
    trimmed = String.trim(value)

    case Jason.decode(trimmed) do
      {:ok, decoded} ->
        decoded

      {:error, _reason} ->
        case String.downcase(trimmed) do
          "true" -> true
          "false" -> false
          "null" -> nil
          _ -> trimmed
        end
    end
  end

  defp candidate_json_strings(text) do
    fenced_json(text) ++ balanced_json_objects(text)
  end

  defp fenced_json(text) do
    ~r/```(?:json)?\s*(.*?)```/s
    |> Regex.scan(text, capture: :all_but_first)
    |> List.flatten()
    |> Enum.map(&String.trim/1)
  end

  defp balanced_json_objects(text) do
    text
    |> String.graphemes()
    |> Enum.reduce({[], 0, nil, 0, false, false, text}, &collect_json_object/2)
    |> elem(0)
    |> Enum.reverse()
  end

  defp collect_json_object(char, {objects, depth, start, index, in_string?, escaped?, text} = state) do
    cond do
      start == nil and char == "{" ->
        {objects, 1, index, index + 1, false, false, text}

      start == nil ->
        {objects, depth, start, index + 1, in_string?, escaped?, text}

      in_string? ->
        cond do
          escaped? -> {objects, depth, start, index + 1, true, false, text}
          char == "\\" -> {objects, depth, start, index + 1, true, true, text}
          char == "\"" -> {objects, depth, start, index + 1, false, false, text}
          true -> {objects, depth, start, index + 1, true, false, text}
        end

      char == "\"" ->
        {objects, depth, start, index + 1, true, false, text}

      char == "{" ->
        {objects, depth + 1, start, index + 1, false, false, text}

      char == "}" and depth == 1 ->
        object = text_slice(state, index)
        {[object | objects], 0, nil, index + 1, false, false, text}

      char == "}" ->
        {objects, depth - 1, start, index + 1, false, false, text}

      true ->
        {objects, depth, start, index + 1, false, false, text}
    end
  end

  defp text_slice({_objects, _depth, start, _index, _in_string?, _escaped?, text}, end_index) do
    String.slice(text, start, end_index - start + 1)
  end

  defp result_output(result) do
    case Map.get(result, "output") || Map.get(result, :output) || result do
      value when is_binary(value) -> value
      value -> Jason.encode!(value)
    end
  end
end
