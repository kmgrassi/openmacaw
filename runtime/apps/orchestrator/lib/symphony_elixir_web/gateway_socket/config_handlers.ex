defmodule SymphonyElixirWeb.GatewaySocket.ConfigHandlers do
  @moduledoc false

  alias SymphonyElixir.Gateway.ConfigSnapshot
  alias SymphonyElixirWeb.Gateway.{Frame, Middleware}

  @spec handle(String.t(), term(), map() | nil, map(), map()) :: {:handled, {[Frame.text_frame()], map()}} | :not_handled
  def handle("config.get", id, _params, state, _context) do
    case ConfigSnapshot.get() do
      {:ok, snapshot} ->
        {:handled, {[Frame.response(id, true, snapshot, nil)], state}}

      {:error, reason} ->
        {:handled, {[Frame.response(id, false, nil, Middleware.normalize_error(reason))], state}}
    end
  end

  def handle("config.set", id, %{"raw" => raw} = params, state, _context) do
    case ConfigSnapshot.set(raw, Map.get(params, "baseHash")) do
      {:ok, snapshot} ->
        {:handled, {[Frame.response(id, true, snapshot, nil)], state}}

      {:error, reason} ->
        {:handled, {[Frame.response(id, false, nil, Middleware.normalize_error(reason))], state}}
    end
  end

  def handle(_method, _id, _params, _state, _context), do: :not_handled
end
