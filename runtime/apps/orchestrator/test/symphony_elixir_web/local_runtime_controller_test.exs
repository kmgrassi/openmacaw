defmodule SymphonyElixirWeb.LocalRuntimeControllerTest do
  use SymphonyElixir.TestSupport

  import Phoenix.ConnTest

  alias SymphonyElixir.LocalRuntime.Registry

  @endpoint SymphonyElixirWeb.Endpoint

  setup do
    start_test_endpoint()

    if Process.whereis(Registry) == nil do
      start_supervised!(Registry)
    end

    Registry.clear()
    :ok
  end

  test "registers and exposes local model capabilities" do
    conn =
      post(build_conn(), "/api/v1/local-runtime/register", %{
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

    conn = get(build_conn(), "/api/v1/local-runtime/capabilities?workspace_id=workspace-1&runner_kind=openai_compatible")

    assert %{"capabilities" => [capability]} = json_response(conn, 200)
    assert capability["provider"] == "ollama"
    assert capability["capabilities"]["json_mode"] == true
  end

  test "probe refreshes latest capability state" do
    post(build_conn(), "/api/v1/local-runtime/register", %{
      "workspace_id" => "workspace-1",
      "machine_id" => "machine-1",
      "runner_kind" => "openai_compatible",
      "provider" => "ollama",
      "model" => "qwen",
      "capabilities" => %{"streaming" => true}
    })

    conn =
      post(build_conn(), "/api/v1/local-runtime/probe", %{
        "workspace_id" => "workspace-1",
        "machine_id" => "machine-1",
        "runner_kind" => "openai_compatible",
        "provider" => "ollama",
        "model" => "qwen",
        "capabilities" => %{"streaming" => true, "tool_calls" => true}
      })

    assert %{"ok" => true, "capabilities" => [%{"model" => "qwen"} | _]} = json_response(conn, 200)

    conn = get(build_conn(), "/api/v1/local-runtime/capabilities?model=qwen")
    assert %{"capabilities" => [%{"source" => "probe", "capabilities" => %{"tool_calls" => true}}]} = json_response(conn, 200)
  end

  test "rejects invalid capability frames" do
    conn = post(build_conn(), "/api/v1/local-runtime/register", %{"workspace_id" => "workspace-1"})

    assert %{"ok" => false, "error" => %{"code" => "invalid_capability_frame"}} = json_response(conn, 400)
  end

  defp start_test_endpoint do
    endpoint_config =
      :symphony_elixir
      |> Application.get_env(SymphonyElixirWeb.Endpoint, [])
      |> Keyword.merge(server: false, secret_key_base: String.duplicate("s", 64))

    Application.put_env(:symphony_elixir, SymphonyElixirWeb.Endpoint, endpoint_config)
    start_supervised!({SymphonyElixirWeb.Endpoint, []})
  end
end
