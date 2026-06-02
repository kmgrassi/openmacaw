defmodule SymphonyElixir.ToolSpec do
  @moduledoc """
  Translates model-agnostic tool definitions into provider-specific formats.
  """

  @type tool_definition :: map()

  @type provider :: :openai | :anthropic | :openai_compatible | :prompt_based

  @type tool_call :: map()

  @doc "Translate a list of tool definitions to provider-specific tool specs."
  @spec to_provider_format([tool_definition()], provider() | String.t()) :: [map()]
  def to_provider_format(tools, provider) when is_list(tools) do
    SymphonyElixir.ToolAdapter.to_tool_specs(tools, provider)
  end

  def to_provider_format(_tools, _provider), do: []

  @doc "Translate a single tool definition."
  @spec translate_tool(tool_definition(), provider() | String.t()) :: map()
  def translate_tool(tool, provider) when provider in [:prompt_based, "prompt_based"] and is_map(tool) do
    %{
      "name" => get_key(tool, :name) || get_key(tool, :slug),
      "description" => description_with_examples(tool),
      "parameters_schema" => get_key(tool, :parameters_schema) || get_key(tool, :parameters) || get_key(tool, :inputSchema) || %{"type" => "object", "properties" => %{}}
    }
  end

  def translate_tool(tool, provider) when is_map(tool) do
    [translated] = SymphonyElixir.ToolAdapter.to_tool_specs([tool], provider)
    translated
  end

  @doc "Normalize provider atoms or strings to the internal provider vocabulary."
  @spec normalize_provider(provider() | String.t() | nil) :: provider()
  def normalize_provider(provider) when provider in [:openai, :anthropic, :openai_compatible, :prompt_based], do: provider
  def normalize_provider("anthropic"), do: :anthropic
  def normalize_provider("prompt_based"), do: :prompt_based
  def normalize_provider("openai"), do: :openai
  def normalize_provider("openai_compatible"), do: :openai_compatible
  def normalize_provider(_provider), do: :openai_compatible

  @doc "Build a prompt-based tool use system message for models without native support."
  @spec prompt_based_system_message([tool_definition()]) :: String.t()
  def prompt_based_system_message([]) do
    "No tools are available for this turn. Answer directly without emitting tool-call JSON."
  end

  def prompt_based_system_message(tools) when is_list(tools) do
    tool_lines =
      tools
      |> Enum.map(&normalized_tool!/1)
      |> Enum.map_join("\n", fn tool ->
        schema = Jason.encode!(tool.parameters_schema)

        "- #{tool.name}: #{tool.description}\n  parameters_schema: #{schema}"
      end)

    """
    You may call one tool when external action or fresh context is required.
    To call a tool, respond with only JSON in this exact shape:
    {"tool_call":{"name":"tool_name","arguments":{}}}

    Do not include prose, markdown, or extra keys when calling a tool.
    If no tool is needed, answer normally.

    Available tools:
    #{tool_lines}
    """
    |> String.trim()
  end

  @doc "Parse a prompt-based tool call from model text output."
  @spec parse_prompt_based_tool_call(String.t()) :: {:ok, tool_call()} | :no_tool_call
  def parse_prompt_based_tool_call(text) when is_binary(text) do
    SymphonyElixir.ToolAdapter.PromptBased.parse_tool_call(text)
  end

  def parse_prompt_based_tool_call(_text), do: :no_tool_call

  defp get_key(map, key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp normalized_tool!(tool) when is_map(tool) do
    %{
      name: get_key(tool, :name) || get_key(tool, :slug),
      description: description_with_examples(tool),
      parameters_schema: get_key(tool, :parameters_schema) || get_key(tool, :parameters) || get_key(tool, :inputSchema) || %{"type" => "object", "properties" => %{}}
    }
  end

  defp description_with_examples(tool) do
    description = get_key(tool, :description) || ""

    case get_key(tool, :examples) do
      examples when is_list(examples) and examples != [] ->
        description <> "\n\nExamples / usage guidance:\n" <> Jason.encode!(Enum.take(examples, 5))

      _ ->
        description
    end
  end
end
