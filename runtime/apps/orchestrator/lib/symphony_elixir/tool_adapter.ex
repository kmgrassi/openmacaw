defmodule SymphonyElixir.ToolAdapter do
  @moduledoc """
  Behaviour for translating between canonical runtime tools and provider shapes.
  """

  @type tool_definition :: map()
  @type tool_call :: SymphonyElixir.ToolCall.t()

  @callback to_tool_specs([tool_definition()]) :: [map()]
  @callback parse_tool_calls(provider_response :: map()) :: [tool_call()]
  @callback format_tool_result(tool_call_id :: String.t(), result :: map()) :: map()

  @doc "Resolve a provider adapter module."
  @spec adapter(SymphonyElixir.ToolSpec.provider() | String.t() | nil) :: module()
  def adapter(provider) do
    case SymphonyElixir.ToolSpec.normalize_provider(provider) do
      :openai -> SymphonyElixir.ToolAdapter.OpenAI
      :openai_compatible -> SymphonyElixir.ToolAdapter.OpenAICompatible
      :anthropic -> SymphonyElixir.ToolAdapter.Anthropic
      :prompt_based -> SymphonyElixir.ToolAdapter.PromptBased
    end
  end

  @doc "Dispatch tool definition formatting through the provider adapter."
  @spec to_tool_specs([tool_definition()], SymphonyElixir.ToolSpec.provider() | String.t() | nil) :: [map()]
  def to_tool_specs(tools, provider) when is_list(tools), do: provider |> adapter() |> apply(:to_tool_specs, [tools])
  def to_tool_specs(_tools, _provider), do: []

  @doc "Dispatch provider response parsing through the provider adapter."
  @spec parse_tool_calls(map(), SymphonyElixir.ToolSpec.provider() | String.t() | nil) :: [tool_call()]
  def parse_tool_calls(response, provider) when is_map(response), do: provider |> adapter() |> apply(:parse_tool_calls, [response])
  def parse_tool_calls(_response, _provider), do: []

  @doc "Dispatch tool-result formatting through the provider adapter."
  @spec format_tool_result(String.t(), map(), SymphonyElixir.ToolSpec.provider() | String.t() | nil) :: map()
  def format_tool_result(tool_call_id, result, provider) when is_binary(tool_call_id) and is_map(result) do
    provider |> adapter() |> apply(:format_tool_result, [tool_call_id, result])
  end
end
