defmodule SymphonyElixir.Schema.GatewayFrame do
  @moduledoc """
  Typed validation boundary for inbound runtime gateway websocket frames.
  """

  defmodule Ping do
    @moduledoc "Gateway keepalive ping frame."

    @enforce_keys [:type]
    defstruct [:type, :ts]

    @type t :: %__MODULE__{type: :ping, ts: term()}
  end

  defmodule Request do
    @moduledoc "Gateway request frame sent by the platform websocket client."

    @enforce_keys [:type, :id, :method]
    defstruct [:type, :id, :method, :params]

    @type t :: %__MODULE__{
            type: :request,
            id: String.t(),
            method: String.t(),
            params: map() | nil
          }
  end

  @type t :: Ping.t() | Request.t()

  @type validation_error ::
          :payload_not_object
          | {:missing_field, String.t()}
          | {:invalid_field, String.t(), :expected_string | :expected_object}
          | {:unsupported_type, term()}

  @spec validate(term()) :: {:ok, t()} | {:error, validation_error()}
  def validate(%{"type" => "ping"} = frame) do
    {:ok, %Ping{type: :ping, ts: Map.get(frame, "ts")}}
  end

  def validate(%{"type" => "req"} = frame) do
    with {:ok, id} <- required_string(frame, "id"),
         {:ok, method} <- required_string(frame, "method"),
         {:ok, params} <- optional_map(frame, "params") do
      {:ok, %Request{type: :request, id: id, method: method, params: params}}
    end
  end

  def validate(%{"type" => type}), do: {:error, {:unsupported_type, type}}
  def validate(%{}), do: {:error, {:missing_field, "type"}}
  def validate(_payload), do: {:error, :payload_not_object}

  @spec error_detail(validation_error()) :: String.t()
  def error_detail(:payload_not_object), do: "payload is not a JSON object"
  def error_detail({:missing_field, field}), do: "missing required field #{field}"

  def error_detail({:invalid_field, field, expected}) do
    "invalid field #{field}: #{expected_detail(expected)}"
  end

  def error_detail({:unsupported_type, type}) do
    "unsupported gateway frame type #{inspect(type)}"
  end

  defp required_string(frame, field) do
    case Map.fetch(frame, field) do
      {:ok, value} when is_binary(value) -> {:ok, value}
      {:ok, _value} -> {:error, {:invalid_field, field, :expected_string}}
      :error -> {:error, {:missing_field, field}}
    end
  end

  defp optional_map(frame, field) do
    case Map.fetch(frame, field) do
      {:ok, value} when is_map(value) -> {:ok, value}
      {:ok, nil} -> {:ok, nil}
      {:ok, _value} -> {:error, {:invalid_field, field, :expected_object}}
      :error -> {:ok, nil}
    end
  end

  defp expected_detail(:expected_string), do: "expected a string"
  defp expected_detail(:expected_object), do: "expected an object"
end
