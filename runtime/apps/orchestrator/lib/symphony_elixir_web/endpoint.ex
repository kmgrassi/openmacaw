defmodule SymphonyElixirWeb.Endpoint do
  @moduledoc """
  Phoenix endpoint for Symphony's optional observability UI and API.
  """

  use Phoenix.Endpoint, otp_app: :symphony_elixir

  @relay_socket_port_env "RELAY_SOCKET_PORT"

  @session_options [
    store: :cookie,
    key: "_symphony_elixir_key",
    signing_salt: "symphony-session"
  ]

  socket("/live", Phoenix.LiveView.Socket,
    websocket: [connect_info: [session: @session_options]],
    longpoll: false
  )

  plug(Plug.RequestId)
  plug(Plug.Telemetry, event_prefix: [:phoenix, :endpoint])

  plug(Plug.Parsers,
    parsers: [:urlencoded, :multipart, :json],
    pass: ["*/*"],
    json_decoder: Jason
  )

  plug(Plug.MethodOverride)
  plug(Plug.Head)
  plug(Plug.Session, @session_options)
  plug(SymphonyElixirWeb.Router)

  @doc """
  Parses `RELAY_SOCKET_PORT` for runtime endpoint configuration.
  """
  @spec relay_socket_port_from_env() :: non_neg_integer() | nil
  def relay_socket_port_from_env do
    parse_relay_socket_port(System.get_env(@relay_socket_port_env))
  end

  @spec parse_relay_socket_port(String.t() | nil) :: non_neg_integer() | nil
  def parse_relay_socket_port(nil), do: nil
  def parse_relay_socket_port(""), do: nil

  def parse_relay_socket_port(value) when is_binary(value) do
    case Integer.parse(value) do
      {port, ""} when port >= 0 ->
        port

      _ ->
        raise ArgumentError, "RELAY_SOCKET_PORT must be a non-negative integer"
    end
  end
end
