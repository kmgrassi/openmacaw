defmodule SymphonyElixirWeb.EndpointTest do
  use ExUnit.Case
  import SymphonyElixir.TestSupport, only: [put_system_env: 2]

  alias SymphonyElixirWeb.Endpoint

  test "relay socket port resolves from RELAY_SOCKET_PORT" do
    put_system_env("RELAY_SOCKET_PORT", "4512")

    assert Endpoint.relay_socket_port_from_env() == 4512
  end

  test "relay socket port is absent when RELAY_SOCKET_PORT is blank" do
    put_system_env("RELAY_SOCKET_PORT", "")

    assert Endpoint.relay_socket_port_from_env() == nil
  end

  test "relay socket port rejects invalid RELAY_SOCKET_PORT" do
    assert_raise ArgumentError, "RELAY_SOCKET_PORT must be a non-negative integer", fn ->
      Endpoint.parse_relay_socket_port("not-a-port")
    end
  end
end
