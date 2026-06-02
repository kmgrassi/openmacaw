defmodule SymphonyElixirWeb.Gateway.Frame do
  @moduledoc """
  JSON frame helpers for the runtime gateway websocket protocol.
  """

  alias SymphonyElixir.Schema.GatewayFrame

  @type decoded_frame :: GatewayFrame.t()
  @type text_frame :: {:text, binary()}

  @spec decode(binary()) :: {:ok, decoded_frame()} | {:error, term()}
  def decode(binary) when is_binary(binary) do
    case Jason.decode(binary) do
      {:ok, frame} -> GatewayFrame.validate(frame)
      {:error, %Jason.DecodeError{} = error} -> {:error, {:invalid_json, Exception.message(error)}}
    end
  end

  @spec response(term(), boolean(), term(), term()) :: text_frame()
  def response(id, ok?, payload, error) do
    text(%{type: "res", id: id, ok: ok?, payload: payload, error: error})
  end

  @spec event(String.t(), term()) :: text_frame()
  def event(name, payload) do
    text(%{type: "event", event: name, payload: payload})
  end

  @spec pong(term()) :: text_frame()
  def pong(ts) do
    text(%{type: "pong", ts: ts})
  end

  @spec text(term()) :: text_frame()
  def text(payload) do
    {:text, Jason.encode!(payload)}
  end
end
