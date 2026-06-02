defmodule SymphonyElixir.Runner.ToolCallingLoop.ToolCallNormalization do
  @moduledoc false

  alias SymphonyElixir.{ToolAdapter, ToolCall}

  @spec normalize_tool_call(term(), non_neg_integer(), map()) :: map()
  def normalize_tool_call(call, index, session) when is_map(call) do
    call =
      cond do
        Map.has_key?(call, :arguments) and Map.has_key?(call, :name) ->
          call

        true ->
          call
          |> ToolAdapter.parse_tool_calls(:openai_compatible)
          |> List.first()
      end

    call = call || ToolCall.new(%{id: "call_#{index + 1}", name: nil, arguments: %{}})
    provider_name = Map.get(call, :provider_name) || Map.get(call, :name)

    Map.put(call, :name, canonical_tool_name(provider_name, session))
  end

  def normalize_tool_call(_call, index, _session),
    do: ToolCall.new(%{id: "call_#{index + 1}", name: nil, arguments: %{}})

  @spec normalize_direct_tool_calls(term(), map()) :: [map()]
  def normalize_direct_tool_calls(tool_calls, session) when is_list(tool_calls) do
    tool_calls
    |> Enum.with_index()
    |> Enum.map(fn {call, index} -> normalize_direct_tool_call(call, index, session) end)
  end

  def normalize_direct_tool_calls(_tool_calls, _session), do: []

  @spec direct_provider_tool_calls(map(), String.t(), map()) :: [map()]
  def direct_provider_tool_calls(turn, output, session) do
    raw_tool_calls = Map.get(turn, :tool_calls) || Map.get(turn, "tool_calls") || []

    case ToolAdapter.parse_tool_calls(direct_provider_response(raw_tool_calls, output, session), session.provider) do
      [] -> raw_tool_calls
      calls -> calls
    end
  end

  @spec prompt_based_tool_calls(String.t(), map()) :: [ToolCall.t()]
  def prompt_based_tool_calls(output, %{provider: provider}) when provider in ["prompt_based", :prompt_based] do
    ToolAdapter.parse_tool_calls(%{"output_text" => output}, :prompt_based)
  end

  def prompt_based_tool_calls(_output, _session), do: []

  @spec parse_frame_tool_calls(map(), map()) :: [ToolCall.t()]
  def parse_frame_tool_calls(%{"event" => "tool_call_request"} = frame, session) do
    frame
    |> Map.get("tool_calls", get_in(frame, ["payload", "tool_calls"]) || [])
    |> then(&ToolAdapter.parse_tool_calls(%{"tool_calls" => &1}, Map.get(session, :provider) || :openai_compatible))
  end

  def parse_frame_tool_calls(frame, session) do
    ToolAdapter.parse_tool_calls(%{"tool_calls" => Map.get(frame, "tool_calls", [])}, Map.get(session, :provider) || :openai_compatible)
  end

  @spec validate_tool_call(map(), [map()]) :: :ok | {:error, String.t()}
  def validate_tool_call(%{name: name}, tools) do
    if tool_definition(name, tools) do
      :ok
    else
      {:error, "Unsupported tool: #{name}"}
    end
  end

  @spec tool_definition(term(), [map()]) :: map() | nil
  def tool_definition(name, tools) do
    Enum.find(tools, fn tool -> map_value(tool, :name) == name || map_value(tool, :slug) == name end)
  end

  @spec tool_execution_kind(map() | nil) :: String.t()
  def tool_execution_kind(tool) do
    case map_value(tool, :execution_kind) do
      value when is_atom(value) -> Atom.to_string(value)
      value when is_binary(value) -> value
      _ -> "helper"
    end
  end

  @spec tool_definitions(map()) :: [map()]
  def tool_definitions(%{tool_definitions: tools}) when is_list(tools), do: tools
  def tool_definitions(%{metadata: %{tool_definitions: tools}}) when is_list(tools), do: tools
  def tool_definitions(_session), do: []

  @spec map_value(term(), atom()) :: term()
  def map_value(map, key) when is_map(map) do
    Map.get(map, key) || Map.get(map, to_string(key))
  end

  def map_value(_map, _key), do: nil

  defp normalize_direct_tool_call(call, index, session) when is_map(call) do
    call =
      cond do
        Map.has_key?(call, :arguments) and Map.has_key?(call, :name) ->
          call

        true ->
          call
          |> ToolAdapter.parse_tool_calls(:openai_compatible)
          |> List.first()
      end

    call = call || ToolCall.new(%{id: "call_#{index + 1}", name: nil, arguments: %{}})
    provider_name = Map.get(call, :provider_name) || Map.get(call, :name)
    arguments = Map.get(call, :arguments) || %{}

    %{
      id: Map.get(call, :id) || "call_#{index + 1}",
      name: canonical_tool_name(provider_name, session),
      provider_name: provider_name,
      arguments: arguments,
      raw_arguments: Map.get(call, :raw_arguments),
      malformed_arguments?: Map.get(call, :malformed_arguments?, false)
    }
  end

  defp normalize_direct_tool_call(_call, index, _session),
    do: %{id: "call_#{index + 1}", name: nil, provider_name: nil, arguments: %{}, raw_arguments: nil, malformed_arguments?: false}

  defp direct_provider_response([], output, session) do
    if Map.get(session, :provider) in ["prompt_based", :prompt_based] do
      %{"output_text" => output}
    else
      %{"tool_calls" => []}
    end
  end

  defp direct_provider_response(tool_calls, _output, _session), do: %{"tool_calls" => tool_calls}

  defp canonical_tool_name(name, session) do
    Map.get(Map.get(session, :provider_tool_name_map, %{}), name, name)
  end
end
