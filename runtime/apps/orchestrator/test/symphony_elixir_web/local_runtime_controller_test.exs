defmodule SymphonyElixirWeb.LocalRuntimeControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest
  import Plug.Conn, only: [put_req_header: 3]
  import SymphonyElixir.TestSupport, only: [put_system_env: 2]

  alias SymphonyElixir.LocalRuntime.Registry

  @endpoint SymphonyElixirWeb.Endpoint
  @service_role_key "service-role-test-key"

  setup do
    start_test_endpoint()
    put_system_env("SUPABASE_SERVICE_ROLE_KEY", @service_role_key)

    if Process.whereis(Registry) == nil do
      start_supervised!(Registry)
    end

    Registry.clear()
    :ok
  end

  test "registers and exposes local model capabilities" do
    conn =
      authed_conn()
      |> post("/api/v1/local-runtime/register", %{
        "workspace_id" => "workspace-1",
        "machine_id" => "machine-1",
        "runner_kind" => "openai_compatible",
        "provider" => "ollama",
        "model" => "qwen2.5-coder:latest",
        "capabilities" => %{"streaming" => true, "json_mode" => true, "context_window" => 32768}
      })

    assert %{"ok" => true, "capabilities" => [registered]} = json_response(conn, 200)
    assert registered["model"] == "qwen2.5-coder:latest"
    assert registered["capabilities"]["streaming"] == true

    conn =
      authed_conn()
      |> get("/api/v1/local-runtime/capabilities?workspace_id=workspace-1&runner_kind=openai_compatible")

    assert %{"capabilities" => [capability]} = json_response(conn, 200)
    assert capability["provider"] == "ollama"
    assert capability["capabilities"]["json_mode"] == true
  end

  test "probe refreshes latest capability state" do
    authed_conn()
    |> post("/api/v1/local-runtime/register", %{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "runner_kind" => "openai_compatible",
      "provider" => "ollama",
      "model" => "qwen",
      "capabilities" => %{"streaming" => true}
    })

    conn =
      authed_conn()
      |> post("/api/v1/local-runtime/probe", %{
        "workspace_id" => "workspace-1",
        "machine_id" => "machine-1",
        "runner_kind" => "openai_compatible",
        "provider" => "ollama",
        "model" => "qwen",
        "capabilities" => %{"streaming" => true, "tool_calls" => true}
      })

    assert %{"ok" => true, "capabilities" => [%{"model" => "qwen"} | _]} = json_response(conn, 200)

    conn = authed_conn() |> get("/api/v1/local-runtime/capabilities?model=qwen")
    assert %{"capabilities" => [%{"source" => "probe", "capabilities" => %{"tool_calls" => true}}]} = json_response(conn, 200)
  end

  test "rejects invalid capability frames" do
    conn = authed_conn() |> post("/api/v1/local-runtime/register", %{"workspace_id" => "workspace-1"})

    assert %{"ok" => false, "error" => %{"code" => "invalid_capability_frame"}} = json_response(conn, 400)
  end

  test "rejects unauthenticated local runtime requests" do
    conn = get(build_conn(), "/api/v1/local-runtime/capabilities")

    assert %{"error" => %{"code" => "auth_required", "message" => "Service-role bearer token is required"}} =
             json_response(conn, 401)
  end

  defp start_test_endpoint do
    endpoint_config =
      :symphony_elixir
      |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
      |> Keyword.merge(server: false, secret_key_base: String.duplicate("s", 64))

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    start_supervised!({SymphonyElixirWeb.Endpoint, []})
  end

  defp authed_conn do
    build_conn()
    |> put_req_header("authorization", "Bearer #{@service_role_key}")
  end
end
