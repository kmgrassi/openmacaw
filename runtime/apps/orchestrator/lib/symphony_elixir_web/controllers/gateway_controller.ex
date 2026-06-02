defmodule SymphonyElixirWeb.GatewayController do
  @moduledoc """
  Raw websocket upgrade endpoint for the runtime gateway protocol.
  """

  use Phoenix.Controller, formats: [:json]

  def upgrade(conn, _params) do
    state = %{
      query_params: conn.query_params,
      request_headers: Map.new(conn.req_headers),
      peer_data: conn.remote_ip
    }

    Plug.Conn.upgrade_adapter(conn, :websocket, {SymphonyElixirWeb.GatewaySocket, state, []})
  end
end
