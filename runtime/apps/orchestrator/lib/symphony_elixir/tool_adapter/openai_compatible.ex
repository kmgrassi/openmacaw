defmodule SymphonyElixir.ToolAdapter.OpenAICompatible do
  @moduledoc "OpenAI-compatible Chat Completions tool-call adapter."

  @behaviour SymphonyElixir.ToolAdapter

  alias SymphonyElixir.ToolAdapter.OpenAI

  @impl true
  def to_tool_specs(tools), do: OpenAI.to_tool_specs(tools)

  @impl true
  def parse_tool_calls(response), do: OpenAI.parse_tool_calls(response)

  @impl true
  def format_tool_result(tool_call_id, result) do
    %{
      "role" => "tool",
      "tool_call_id" => tool_call_id,
      "content" => result_output(result)
    }
  end

  defp result_output(result) do
    case Map.get(result, "output") || Map.get(result, :output) || result do
      value when is_binary(value) -> value
      value -> Jason.encode!(value)
    end
  end
end
