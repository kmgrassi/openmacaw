defmodule SymphonyElixirWeb.LocalRelayControllerTest do
  use SymphonyElixir.TestSupport

  import Plug.Conn
  import Plug.Test

  alias SymphonyElixirWeb.LocalRelayController

  setup do
    delete_app_env(:symphony_elixir, :local_relay_require_tls)
    delete_app_env(:symphony_elixir, :local_relay_allowed_origins)
    delete_system_env("LOCAL_RELAY_ALLOWED_ORIGINS")

    :ok
  end

  test "rejects non-TLS relay websocket upgrades when TLS is required" do
    put_app_env(:symphony_elixir, :local_relay_require_tls, true)

    conn =
      :get
      |> conn("/local-relay/ws")
      |> LocalRelayController.upgrade(%{})

    assert conn.halted
    assert conn.status == 403
    assert %{"error" => %{"code" => "tls_required"}} = Jason.decode!(conn.resp_body)
  end

  test "rejects disallowed origins when origins are configured" do
    put_app_env(:symphony_elixir, :local_relay_require_tls, true)
    put_app_env(:symphony_elixir, :local_relay_allowed_origins, ["https://relay.example.com"])

    conn =
      :get
      |> conn("/local-relay/ws")
      |> put_req_header("x-forwarded-proto", "https")
      |> put_req_header("origin", "https://evil.example.com")
      |> LocalRelayController.upgrade(%{})

    assert conn.halted
    assert conn.status == 403
    assert %{"error" => %{"code" => "origin_not_allowed"}} = Jason.decode!(conn.resp_body)
  end

  test "reads allowed origins from runtime environment" do
    put_app_env(:symphony_elixir, :local_relay_require_tls, true)
    put_app_env(:symphony_elixir, :local_relay_allowed_origins, [])
    put_system_env("LOCAL_RELAY_ALLOWED_ORIGINS", "https://relay.example.com")

    conn =
      :get
      |> conn("/local-relay/ws")
      |> put_req_header("x-forwarded-proto", "https")
      |> put_req_header("origin", "https://evil.example.com")
      |> LocalRelayController.upgrade(%{})

    assert conn.halted
    assert conn.status == 403
    assert %{"error" => %{"code" => "origin_not_allowed"}} = Jason.decode!(conn.resp_body)
  end
end
