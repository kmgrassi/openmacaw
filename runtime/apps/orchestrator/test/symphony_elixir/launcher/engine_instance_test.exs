defmodule SymphonyElixir.Launcher.EngineInstanceTest do
  use SymphonyElixir.TestSupport, async: false
  import ExUnit.CaptureLog

  alias SymphonyElixir.Launcher.EngineInstance

  @base_attrs %{
    instance_id: "orch_abc",
    agent_id: "agent-1",
    workspace_id: "workspace-1",
    port: 4000
  }

  setup do
    put_app_envs(:symphony_elixir,
      launcher_engine_instance_req_options: [plug: {Req.Test, EngineInstance}],
      launcher_engine_instance: [
        endpoint: "https://test.supabase.co/rest/v1",
        api_key: "test-api-key",
        table: "engine_instance",
        host: "test-host"
      ]
    )

    :ok
  end

  describe "enabled?/0" do
    test "returns true when endpoint and api_key are set" do
      assert EngineInstance.enabled?()
    end

    test "returns false when endpoint is missing" do
      put_app_env(:symphony_elixir, :launcher_engine_instance,
        endpoint: "",
        api_key: "k"
      )

      refute EngineInstance.enabled?()
    end

    test "returns false when api_key is missing" do
      put_app_env(:symphony_elixir, :launcher_engine_instance,
        endpoint: "https://x.supabase.co/rest/v1",
        api_key: ""
      )

      refute EngineInstance.enabled?()
    end
  end

  describe "host/0" do
    test "returns configured host" do
      assert EngineInstance.host() == "test-host"
    end
  end

  describe "upsert/1" do
    test "returns :disabled when not configured" do
      delete_app_env(:symphony_elixir, :launcher_engine_instance)
      assert :disabled = EngineInstance.upsert(@base_attrs)
    end

    test "PATCHes a stale active row for the same workspace, agent, and role" do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        send(test_pid, {:request, conn.method, conn.request_path, conn.query_string})

        assert conn.method == "PATCH"
        assert conn.request_path == "/rest/v1/engine_instance"

        assert URI.decode_query(conn.query_string) == %{
                 "agent_id" => "eq.agent-1",
                 "role" => "eq.unified",
                 "status" => "in.(failed,unhealthy)",
                 "workspace_id" => "eq.workspace-1"
               }

        {:ok, body, conn} = Plug.Conn.read_body(conn)
        payload = Jason.decode!(body)

        assert payload["instance_id"] == "orch_abc"
        assert payload["agent_id"] == "agent-1"
        assert payload["workspace_id"] == "workspace-1"
        assert payload["host"] == "test-host"
        assert payload["port"] == 4000
        assert payload["role"] == "unified"
        assert payload["status"] == "running"
        assert is_binary(payload["started_at"])
        assert is_binary(payload["updated_at"])

        prefer = Plug.Conn.get_req_header(conn, "prefer") |> List.first()
        assert prefer =~ "return=representation"

        assert Plug.Conn.get_req_header(conn, "apikey") == ["test-api-key"]
        assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer test-api-key"]

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(200, Jason.encode!([payload]))
      end)

      assert :ok = EngineInstance.upsert(@base_attrs)
      assert_received {:request, "PATCH", "/rest/v1/engine_instance", query}
      assert URI.decode_query(query)["status"] == "in.(failed,unhealthy)"
    end

    test "POSTs a running row when no active row exists" do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "PATCH" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "POST" ->
            send(test_pid, {:request, conn.method, conn.request_path, conn.query_string})

            assert conn.request_path == "/rest/v1/engine_instance"
            assert conn.query_string == "on_conflict=instance_id"

            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)
            assert payload["instance_id"] == "orch_abc"
            assert payload["status"] == "running"

            prefer = Plug.Conn.get_req_header(conn, "prefer") |> List.first()
            assert prefer =~ "return=minimal"
            assert prefer =~ "resolution=merge-duplicates"

            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      assert :ok = EngineInstance.upsert(@base_attrs)
      assert_received {:request, "POST", "/rest/v1/engine_instance", "on_conflict=instance_id"}
    end

    test "retries active-row replacement when insert hits the active unique index" do
      test_pid = self()
      patch_count = :counters.new(1, [])

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "PATCH" ->
            :counters.add(patch_count, 1, 1)

            if :counters.get(patch_count, 1) == 1 do
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")
            else
              send(test_pid, :replacement_retry)

              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, ~s([{"instance_id":"orch_abc"}]))
            end

          "POST" ->
            Plug.Conn.send_resp(conn, 409, ~s({"code":"23505"}))
        end
      end)

      assert :ok = EngineInstance.upsert(@base_attrs)
      assert_received :replacement_retry
    end

    test "returns a conflict instead of replacing a non-stale active row" do
      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "PATCH" ->
            assert URI.decode_query(conn.query_string)["status"] == "in.(failed,unhealthy)"

            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "POST" ->
            Plug.Conn.send_resp(conn, 409, ~s({"code":"23505"}))
        end
      end)

      assert {:error, {:active_row_conflict, "agent-1"}} = EngineInstance.upsert(@base_attrs)
    end

    test "allows explicit role override" do
      Req.Test.stub(EngineInstance, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        payload = Jason.decode!(body)

        assert payload["role"] == "worker"

        Plug.Conn.send_resp(conn, 201, "")
      end)

      assert :ok = EngineInstance.upsert(Map.put(@base_attrs, :role, "worker"))
    end

    test "returns {:error, {:missing_field, _}} when required fields are missing" do
      assert {:error, {:missing_field, :agent_id}} =
               EngineInstance.upsert(Map.delete(@base_attrs, :agent_id))

      assert {:error, {:missing_field, :workspace_id}} =
               EngineInstance.upsert(Map.delete(@base_attrs, :workspace_id))

      assert {:error, {:missing_field, :port}} =
               EngineInstance.upsert(Map.delete(@base_attrs, :port))
    end

    test "surfaces HTTP errors" do
      Req.Test.stub(EngineInstance, fn conn ->
        Plug.Conn.send_resp(conn, 500, ~s({"message":"boom"}))
      end)

      assert {:error, {:http_error, 500, _}} = EngineInstance.upsert(@base_attrs)
    end
  end

  describe "update_status/2" do
    test "PATCHes status and updated_at" do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        send(test_pid, {:patch, conn.query_string})

        assert conn.method == "PATCH"
        assert conn.request_path == "/rest/v1/engine_instance"
        assert conn.query_string == "instance_id=eq.orch_abc"

        {:ok, body, conn} = Plug.Conn.read_body(conn)
        payload = Jason.decode!(body)
        assert payload["status"] == "stopped"
        assert is_binary(payload["updated_at"])
        refute Map.has_key?(payload, "last_health_at")

        Plug.Conn.send_resp(conn, 204, "")
      end)

      assert :ok = EngineInstance.update_status("orch_abc", :stopped)
      assert_received {:patch, "instance_id=eq.orch_abc"}
    end

    test "returns :disabled when not configured" do
      Application.delete_env(:symphony_elixir, :launcher_engine_instance)
      assert :disabled = EngineInstance.update_status("orch_abc", :stopped)
    end
  end

  describe "heartbeat/1" do
    test "PATCHes last_health_at and updated_at" do
      Req.Test.stub(EngineInstance, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        payload = Jason.decode!(body)

        assert is_binary(payload["last_health_at"])
        assert payload["last_health_at"] == payload["updated_at"]
        refute Map.has_key?(payload, "status")

        Plug.Conn.send_resp(conn, 204, "")
      end)

      log =
        capture_log([level: :debug], fn ->
          assert :ok = EngineInstance.heartbeat("orch_abc")
        end)

      assert log =~ ~s("caller":"launcher.engine_instance.heartbeat")
      assert log =~ ~s("instance_id":"orch_abc")
    end
  end

  describe "list_by_host/1" do
    test "returns rows matching the host filter" do
      Req.Test.stub(EngineInstance, fn conn ->
        assert conn.method == "GET"
        assert conn.request_path == "/rest/v1/engine_instance"
        assert URI.decode_query(conn.query_string) == %{"host" => "eq.test-host"}

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(
          200,
          Jason.encode!([
            %{"instance_id" => "orch_1", "host" => "test-host", "status" => "running"}
          ])
        )
      end)

      assert {:ok, [%{"instance_id" => "orch_1"}]} = EngineInstance.list_by_host("test-host")
    end

    test "returns :disabled when not configured" do
      Application.delete_env(:symphony_elixir, :launcher_engine_instance)
      assert :disabled = EngineInstance.list_by_host("test-host")
    end
  end
end
