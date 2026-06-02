defmodule SymphonyElixir.ToolCall do
  @moduledoc """
  Canonical tool call and result shapes used by the runtime.

  Provider adapters normalize native tool-call shapes into this struct before
  runners validate, execute, log, or format results.
  """

  @type t :: %__MODULE__{
          id: String.t() | nil,
          name: String.t() | nil,
          arguments: map(),
          provider_name: String.t() | nil,
          raw_arguments: term(),
          malformed_arguments?: boolean(),
          metadata: map() | nil
        }

  @type result :: %{
          required(:output) => term(),
          optional(:usage) => map() | nil,
          optional(:metadata) => map() | nil
        }

  defstruct id: nil,
            name: nil,
            arguments: %{},
            provider_name: nil,
            raw_arguments: nil,
            malformed_arguments?: false,
            metadata: nil

  @doc "Build a canonical tool call from adapter-normalized fields."
  @spec new(keyword() | map()) :: t()
  def new(attrs) when is_list(attrs), do: attrs |> Map.new() |> new()

  def new(attrs) when is_map(attrs) do
    %__MODULE__{
      id: string_value(attrs, :id) || string_value(attrs, :tool_call_id) || "call_1",
      name: string_value(attrs, :name),
      arguments: map_value(attrs, :arguments) || %{},
      provider_name: string_value(attrs, :provider_name),
      raw_arguments: map_value(attrs, :raw_arguments),
      malformed_arguments?: map_value(attrs, :malformed_arguments?) || false,
      metadata: map_value(attrs, :metadata)
    }
  end

  @doc "Build a canonical tool-call struct from provider-decoded fields."
  @spec new(String.t(), map(), keyword()) :: t()
  def new(name, arguments, opts \\ []) when is_binary(name) and is_map(arguments) do
    %__MODULE__{
      id: Keyword.get(opts, :id),
      name: name,
      arguments: arguments,
      provider_name: Keyword.get(opts, :provider_name),
      raw_arguments: Keyword.get(opts, :raw_arguments),
      malformed_arguments?: Keyword.get(opts, :malformed_arguments?, false),
      metadata: Keyword.get(opts, :metadata)
    }
  end

  @doc "Decode provider arguments while preserving malformed JSON for callers that need to reject it."
  @spec decode_arguments(term()) :: {map(), boolean()}
  def decode_arguments(arguments) when is_map(arguments), do: {arguments, false}

  def decode_arguments(arguments) when is_binary(arguments) do
    case Jason.decode(arguments) do
      {:ok, decoded} when is_map(decoded) -> {decoded, false}
      _ -> {%{}, true}
    end
  end

  def decode_arguments(_arguments), do: {%{}, false}

  @doc "Encode canonical arguments for repeated-call detection."
  @spec canonical_arguments(term()) :: String.t()
  def canonical_arguments(arguments) do
    case Jason.encode(arguments) do
      {:ok, encoded} -> encoded
      _ -> inspect(arguments)
    end
  end

  @doc "Normalize a tool execution response into the registry result shape."
  @spec result(term()) :: result()
  def result(%{output: _output} = result), do: normalize_result(result)
  def result(%{"output" => output} = result), do: normalize_result(Map.put(result, :output, output))
  def result(output), do: %{output: output, usage: nil, metadata: nil}

  defp normalize_result(result) do
    %{
      output: Map.get(result, :output),
      usage: Map.get(result, :usage) || Map.get(result, "usage"),
      metadata: Map.get(result, :metadata) || Map.get(result, "metadata")
    }
  end

  defp string_value(map, key) do
    case map_value(map, key) do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp map_value(map, key) when is_atom(key), do: Map.get(map, key) || Map.get(map, Atom.to_string(key))
end
