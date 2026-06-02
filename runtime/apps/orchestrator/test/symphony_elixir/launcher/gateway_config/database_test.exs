defmodule SymphonyElixir.Launcher.GatewayConfig.DatabaseTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  alias SymphonyElixir.Launcher.GatewayConfig.Database
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved
  alias SymphonyElixir.SupabaseSchema

  setup do
    Application.put_env(:symphony_elixir, :launcher_gateway_config_req_options, plug: {Req.Test, Database})

    Application.put_env(:symphony_elixir, :launcher_gateway_config,
      endpoint: "https://test.supabase.co/rest/v1",
      api_key: "test-api-key",
      table: "gateway_config",
      state_table: "gateway_config_state"
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :launcher_gateway_config_req_options)
      Application.delete_env(:symphony_elixir, :launcher_gateway_config)
    end)

    :ok
  end

  test "fetch/2 returns a Resolved struct when a row exists" do
    row =
      gateway_config_row(%{
        "scope_type" => "agent",
        "scope_id" => "agent-1",
        "config_hash" => "hash-abc",
        "version" => 3,
        "config_json" => %{"tracker" => %{"kind" => "memory"}, "runners" => []}
      })

    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/gateway_config"

      params = URI.decode_query(conn.query_string)
      assert params["select"] == SupabaseSchema.select_columns!("gateway_config")
      assert params["scope_type"] == "eq.agent"
      assert params["scope_id"] == "eq.agent-1"
      assert params["limit"] == "1"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([row]))
    end)

    assert {:ok, %Resolved{} = resolved} = Database.fetch("agent", "agent-1")
    assert resolved.scope_type == "agent"
    assert resolved.scope_id == "agent-1"
    assert resolved.config_hash == "hash-abc"
    assert resolved.version == 3
    assert resolved.config_json == %{"tracker" => %{"kind" => "memory"}, "runners" => []}
  end

  test "fetch/2 returns :not_found when no row matches" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "GET"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    assert {:error, :not_found} = Database.fetch("agent", "missing")
  end

  test "fetch/2 rejects rows that drift from the canonical Supabase types" do
    row =
      gateway_config_row(%{
        "scope_type" => "agent",
        "scope_id" => "agent-1",
        "config_hash" => 123
      })

    Req.Test.stub(Database, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([row]))
    end)

    assert {:error, {:invalid_column_type, "gateway_config", "config_hash", ["string"], 123}} =
             Database.fetch("agent", "agent-1")
  end

  test "record_apply_state/4 upserts gateway_config_state on success" do
    Req.Test.stub(Database, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/gateway_config_state"

      params = URI.decode_query(conn.query_string)
      assert params["on_conflict"] == "scope_type,scope_id"

      prefer = Plug.Conn.get_req_header(conn, "prefer") |> List.first()
      assert prefer =~ "resolution=merge-duplicates"

      {:ok, raw, conn} = Plug.Conn.read_body(conn)
      body = Jason.decode!(raw)

      assert body["scope_type"] == "agent"
      assert body["scope_id"] == "agent-1"
      assert body["last_apply_status"] == "ok"
      assert body["last_applied_hash"] == "hash-abc"
      assert body["last_applied_version"] == 3
      assert body["broker_instance_id"] == "orch_abc"
      assert is_binary(body["last_apply_at"])
      refute Map.has_key?(body, "last_apply_error")

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([body]))
    end)

    assert :ok =
             Database.record_apply_state("agent", "agent-1", :ok,
               last_applied_hash: "hash-abc",
               last_applied_version: 3,
               broker_instance_id: "orch_abc"
             )
  end

  test "record_apply_state/4 upserts gateway_config_state with error details on failure" do
    Req.Test.stub(Database, fn conn ->
      {:ok, raw, conn} = Plug.Conn.read_body(conn)
      body = Jason.decode!(raw)

      assert body["last_apply_status"] == "error"
      assert body["last_apply_error"] == "boom"
      assert body["broker_instance_id"] == nil || body["broker_instance_id"] == "orch_abc"

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([body]))
    end)

    assert :ok =
             Database.record_apply_state("agent", "agent-1", :error,
               broker_instance_id: "orch_abc",
               last_apply_error: "boom"
             )
  end

  test "fetch/2 emits postgrest logs tagged with caller and process trace id" do
    Req.Test.stub(Database, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, "[]")
    end)

    previous = Process.get(:symphony_trace_id)
    Process.put(:symphony_trace_id, "trc-gateway-fetch")

    try do
      log = capture_log(fn -> Database.fetch("workspace", "ws-1") end)

      assert log =~ ~s("caller":"launcher.gateway_config.fetch")
      assert log =~ ~s("trace_id":"trc-gateway-fetch")
      refute log =~ ~s("missing_required_fields":["trace_id")
      refute log =~ ~s("missing_required_fields":["caller")
    after
      case previous do
        nil -> Process.delete(:symphony_trace_id)
        value -> Process.put(:symphony_trace_id, value)
      end
    end
  end

  test "record_apply_state/4 emits postgrest logs tagged with caller and process trace id" do
    Req.Test.stub(Database, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, "[]")
    end)

    previous = Process.get(:symphony_trace_id)
    Process.put(:symphony_trace_id, "trc-gateway-state")

    try do
      log = capture_log(fn -> Database.record_apply_state("workspace", "ws-1", :ok, []) end)

      assert log =~ ~s("caller":"launcher.gateway_config.record_apply_state")
      assert log =~ ~s("trace_id":"trc-gateway-state")
      refute log =~ ~s("missing_required_fields":["trace_id")
      refute log =~ ~s("missing_required_fields":["caller")
    after
      case previous do
        nil -> Process.delete(:symphony_trace_id)
        value -> Process.put(:symphony_trace_id, value)
      end
    end
  end

  defp gateway_config_row(overrides) do
    Map.merge(
      %{
        "config_hash" => "hash-default",
        "config_json" => %{},
        "id" => "config-default",
        "scope_id" => "agent-default",
        "scope_type" => "agent",
        "updated_at" => "2026-04-22T00:00:00Z",
        "updated_by" => "user-default",
        "version" => 1
      },
      overrides
    )
  end
end
