defmodule SymphonyElixir.ToolAdapter.OpenAI do
  @moduledoc "OpenAI tool-call adapter."

  @behaviour SymphonyElixir.ToolAdapter

  alias SymphonyElixir.ToolCall

  @impl true
  def to_tool_specs(tools) when is_list(tools), do: Enum.map(tools, &openai_tool/1)

  @impl true
  def parse_tool_calls(response) when is_map(response) do
    response
    |> response_tool_call_items()
    |> Enum.with_index()
    |> Enum.map(fn {call, index} -> normalize_tool_call(call, index) end)
  end

  @impl true
  def format_tool_result(tool_call_id, result) do
    %{
      "type" => "function_call_output",
      "call_id" => tool_call_id,
      "output" => result_output(result)
    }
  end

  defp response_tool_call_items(%{"output" => output}) when is_list(output) do
    Enum.filter(output, &(Map.get(&1, "type") == "function_call"))
  end

  defp response_tool_call_items(%{"tool_calls" => calls}) when is_list(calls), do: calls

  defp response_tool_call_items(%{"choices" => choices}) when is_list(choices) do
    choices
    |> List.first(%{})
    |> get_in(["message", "tool_calls"])
    |> list_or_empty()
  end

  defp response_tool_call_items(_response), do: []

  defp normalize_tool_call(%{"type" => "function_call"} = call, index) do
    raw_arguments = Map.get(call, "arguments") || %{}
    {arguments, malformed?} = ToolCall.decode_arguments(raw_arguments)

    ToolCall.new(%{
      id: Map.get(call, "call_id") || Map.get(call, "id") || "call_#{index + 1}",
      name: Map.get(call, "name"),
      arguments: arguments,
      raw_arguments: if(malformed?, do: raw_arguments),
      malformed_arguments?: malformed?
    })
  end

  defp normalize_tool_call(call, index) do
    function = map_value(call, :function) || %{}
    raw_arguments = map_value(call, :arguments) || map_value(function, :arguments)
    {arguments, malformed?} = ToolCall.decode_arguments(raw_arguments)

    ToolCall.new(%{
      id: map_value(call, :id) || map_value(call, :tool_call_id) || "call_#{index + 1}",
      name: map_value(call, :name) || map_value(function, :name),
      arguments: arguments,
      raw_arguments: if(malformed?, do: raw_arguments),
      malformed_arguments?: malformed?
    })
  end

  defp openai_tool(tool) do
    tool = normalized_tool!(tool)

    %{
      "type" => "function",
      "function" => %{
        "name" => tool.name,
        "description" => tool.description,
        "parameters" => tool.parameters_schema
      }
    }
  end

  defp normalized_tool!(tool) when is_map(tool) do
    name = required_string(tool, :name) || required_string(tool, :slug)
    validate_tool_name!(name)

    %{
      name: name,
      description: description_with_examples(tool),
      parameters_schema: parameters_schema(tool)
    }
  end

  defp description_with_examples(tool) do
    description = optional_string(tool, :description)

    case get_key(tool, :examples) do
      examples when is_list(examples) and examples != [] ->
        description <> "\n\nExamples / usage guidance:\n" <> Jason.encode!(Enum.take(examples, 5))

      _ ->
        description
    end
  end

  defp parameters_schema(tool) do
    case get_key(tool, :parameters_schema) || get_key(tool, :parameters) || get_key(tool, :inputSchema) || get_key(tool, :input_schema) do
      schema when is_map(schema) -> schema
      _ -> %{"type" => "object", "properties" => %{}}
    end
  end

  defp result_output(result) do
    case Map.get(result, "output") || Map.get(result, :output) || result do
      value when is_binary(value) -> value
      value -> Jason.encode!(value)
    end
  end

  defp required_string(tool, key) do
    case get_key(tool, key) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp optional_string(tool, key) do
    case get_key(tool, key) do
      value when is_binary(value) -> value
      _ -> ""
    end
  end

  defp get_key(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))
  defp map_value(map, key) when is_atom(key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))
  defp list_or_empty(list) when is_list(list), do: list
  defp list_or_empty(_value), do: []

  defp validate_tool_name!(nil), do: raise(ArgumentError, "tool name must be a non-empty string")

  defp validate_tool_name!(name) do
    unless Regex.match?(~r/^[a-z][a-z0-9_.]{0,62}$/, name) do
      raise ArgumentError, "invalid tool name #{inspect(name)}; expected to match ^[a-z][a-z0-9_.]{0,62}$"
    end
  end
end
