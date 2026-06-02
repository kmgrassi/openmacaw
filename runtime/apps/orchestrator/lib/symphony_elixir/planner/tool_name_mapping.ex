defmodule SymphonyElixir.Planner.ToolNameMapping do
  @moduledoc """
  Provider-safe planner tool names and tool spec normalization.
  """

  @default_parameters %{"type" => "object", "properties" => %{}}
  @type runtime_name :: String.t()
  @type provider_name :: String.t()
  @type name_map :: %{runtime_name() => provider_name()}

  @doc "Build a runtime-name to provider-name map."
  @spec runtime_to_provider([runtime_name()] | term()) :: name_map()
  def runtime_to_provider(tool_names) when is_list(tool_names) do
    Enum.reduce(tool_names, %{}, fn tool_name, acc ->
      Map.put(acc, tool_name, unique_provider_name(tool_name, Map.values(acc)))
    end)
  end

  def runtime_to_provider(_tool_names), do: %{}

  @doc "Build a provider-name to runtime-name map."
  @spec provider_to_runtime([runtime_name()] | term()) :: %{provider_name() => runtime_name()}
  def provider_to_runtime(tool_names) when is_list(tool_names) do
    tool_names
    |> runtime_to_provider()
    |> Map.new(fn {runtime_name, provider_name} -> {provider_name, runtime_name} end)
  end

  def provider_to_runtime(_tool_names), do: %{}

  @spec provider_name(runtime_name() | term(), name_map() | term()) :: provider_name()
  def provider_name(runtime_name, runtime_to_provider) when is_map(runtime_to_provider) do
    Map.get(runtime_to_provider, runtime_name, safe_provider_name(runtime_name))
  end

  def provider_name(runtime_name, _runtime_to_provider), do: safe_provider_name(runtime_name)

  @spec runtime_name(provider_name() | term(), name_map() | term()) :: runtime_name() | term()
  def runtime_name(provider_name, runtime_to_provider)
      when is_binary(provider_name) and is_map(runtime_to_provider) do
    Enum.find_value(runtime_to_provider, provider_name, fn {runtime_name, mapped_provider_name} ->
      if mapped_provider_name == provider_name, do: runtime_name
    end)
  end

  def runtime_name(provider_name, _runtime_to_provider), do: provider_name

  @spec responses_tool_spec(map(), name_map() | term()) :: map()
  def responses_tool_spec(spec, runtime_to_provider) when is_map(spec) do
    runtime_name = tool_name(spec)

    %{
      "type" => "function",
      "name" => provider_name(runtime_name, runtime_to_provider),
      "description" => tool_description(spec),
      "parameters" => tool_parameters(spec)
    }
  end

  @spec put_provider_tool_name(map(), name_map() | term()) :: map()
  def put_provider_tool_name(%{"function" => %{"name" => runtime_name}} = spec, runtime_to_provider) do
    put_in(spec, ["function", "name"], provider_name(runtime_name, runtime_to_provider))
  end

  def put_provider_tool_name(%{"name" => runtime_name} = spec, runtime_to_provider) do
    Map.put(spec, "name", provider_name(runtime_name, runtime_to_provider))
  end

  def put_provider_tool_name(spec, _runtime_to_provider), do: spec

  @spec tool_name(map() | term()) :: runtime_name() | nil
  def tool_name(spec) when is_map(spec) do
    Map.get(spec, "name") || Map.get(spec, :name) || Map.get(spec, "slug") || Map.get(spec, :slug)
  end

  def tool_name(_spec), do: nil

  @spec tool_description(map() | term()) :: String.t()
  def tool_description(spec) when is_map(spec) do
    description = Map.get(spec, "description") || Map.get(spec, :description) || ""

    case Map.get(spec, "examples") || Map.get(spec, :examples) do
      examples when is_list(examples) and examples != [] ->
        description <> "\n\nExamples / usage guidance:\n" <> Jason.encode!(Enum.take(examples, 5))

      _ ->
        description
    end
  end

  def tool_description(_spec), do: ""

  @spec tool_parameters(map() | term()) :: map()
  def tool_parameters(spec) when is_map(spec) do
    case Map.get(spec, "inputSchema") || Map.get(spec, :inputSchema) ||
           Map.get(spec, "parameters_schema") || Map.get(spec, :parameters_schema) ||
           Map.get(spec, "parameters") || Map.get(spec, :parameters) do
      schema when is_map(schema) -> schema
      _ -> @default_parameters
    end
  end

  def tool_parameters(_spec), do: @default_parameters

  @spec safe_provider_name(runtime_name() | term()) :: provider_name()
  def safe_provider_name(tool_name) when is_binary(tool_name) do
    tool_name
    |> String.replace(~r/[^a-zA-Z0-9_-]/, "_")
    |> String.slice(0, 64)
  end

  def safe_provider_name(_tool_name), do: "tool"

  defp unique_provider_name(tool_name, existing_provider_names) do
    base_name = safe_provider_name(tool_name)
    existing_provider_names = MapSet.new(existing_provider_names)

    Stream.iterate(0, &(&1 + 1))
    |> Enum.find_value(fn
      0 ->
        if MapSet.member?(existing_provider_names, base_name), do: nil, else: base_name

      index ->
        candidate = "#{base_name}_#{index}"
        if MapSet.member?(existing_provider_names, candidate), do: nil, else: candidate
    end)
  end
end
