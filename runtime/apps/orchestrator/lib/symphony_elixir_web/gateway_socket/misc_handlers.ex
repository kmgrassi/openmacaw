defmodule SymphonyElixirWeb.GatewaySocket.MiscHandlers do
  @moduledoc false

  alias SymphonyElixir.Gateway.SessionStore
  alias SymphonyElixirWeb.Gateway.Frame

  @spec handle(String.t(), term(), map() | nil, map(), map()) :: {:handled, {[Frame.text_frame()], map()}} | :not_handled
  def handle("channels.status", id, _params, state, _context) do
    payload = %{channelOrder: [], channelLabels: %{}, channelAccounts: %{}}
    {:handled, {[Frame.response(id, true, payload, nil)], state}}
  end

  def handle("usage.cost", id, _params, state, _context) do
    usage = SessionStore.usage_snapshot()
    {:handled, {[Frame.response(id, true, %{totals: usage.totals}, nil)], state}}
  end

  def handle("web.login.start", id, _params, state, _context) do
    {:handled, {[Frame.response(id, true, %{message: "web login is not configured for this runtime"}, nil)], state}}
  end

  def handle("web.login.wait", id, _params, state, _context) do
    {:handled,
     {[
        Frame.response(
          id,
          true,
          %{message: "web login is not configured for this runtime", connected: false},
          nil
        )
      ], state}}
  end

  def handle(_method, _id, _params, _state, _context), do: :not_handled
end
