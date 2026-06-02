defmodule SymphonyElixir.ToolAdapter.Anthropic do
  @moduledoc "Anthropic Messages tool-use adapter."

  @behaviour SymphonyElixir.ToolAdapter

  alias SymphonyElixir.ToolCall

  @impl true
  def to_tool_specs(tools) when is_list(tools), do: Enum.map(tools, &anthropic_tool/1)

  @impl true
  def parse_tool_calls(response) when is_map(response) do
    response
    |> Map.get("content", [])
    |> Enum.filter(&(Map.get(&1, "type") == "tool_use"))
    |> Enum.with_index()
    |> Enum.map(fn {block, index} ->
      raw_arguments = Map.get(block, "input") || %{}
      {arguments, malformed?} = ToolCall.decode_arguments(raw_arguments)

      ToolCall.new(%{
        id: Map.get(block, "id") || "call_#{index + 1}",
        name: Map.get(block, "name"),
        arguments: arguments,
        raw_arguments: if(malformed?, do: raw_arguments),
        malformed_arguments?: malformed?
      })
    end)
  end

  @impl true
  def format_tool_result(tool_call_id, result) do
    %{
      "type" => "tool_result",
      "tool_use_id" => tool_call_id,
      "content" => result_output(result),
      "is_error" => Map.get(result, "success") == false or Map.get(result, :success) == false
    }
  end

  defp anthropic_tool(tool) do
    tool = normalized_tool!(tool)

    %{
      "name" => tool.name,
      "description" => tool.description,
      "input_schema" => tool.parameters_schema
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

  defp validate_tool_name!(nil), do: raise(ArgumentError, "tool name must be a non-empty string")

  defp validate_tool_name!(name) do
    unless Regex.match?(~r/^[a-z][a-z0-9_.]{0,62}$/, name) do
      raise ArgumentError, "invalid tool name #{inspect(name)}; expected to match ^[a-z][a-z0-9_.]{0,62}$"
    end
  end
end
