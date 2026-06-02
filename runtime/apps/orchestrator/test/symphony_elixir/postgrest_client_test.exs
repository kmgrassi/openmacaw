defmodule SymphonyElixir.PostgRESTClientTest do
  use ExUnit.Case, async: true
  import ExUnit.CaptureLog

  alias SymphonyElixir.PostgRESTClient

  setup do
    req_options = [plug: {Req.Test, __MODULE__}]
    client = PostgRESTClient.new(%{endpoint: "https://test.supabase.co", api_key: "secret"}, req_options)

    {:ok, client: client}
  end

  test "GET normalizes endpoint, applies auth headers, and returns decoded body", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "GET"
      assert conn.request_path == "/rest/v1/work_items"
      assert URI.decode_query(conn.query_string) == %{"state" => "eq.todo"}
      assert {"apikey", "secret"} in conn.req_headers
      assert {"authorization", "Bearer secret"} in conn.req_headers
      assert {"accept", "application/json"} in conn.req_headers

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1"}]))
    end)

    assert {:ok, [%{"id" => "wi-1"}]} = PostgRESTClient.get(client, "work_items", %{"state" => "eq.todo"})
  end

  test "successful requests emit started and completed logs with metadata", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1"}, %{"id" => "wi-2"}]))
    end)

    log =
      capture_log(fn ->
        assert {:ok, [%{"id" => "wi-1"}, %{"id" => "wi-2"}]} =
                 PostgRESTClient.get(client, "work_items", %{"state" => "eq.todo", "select" => "id"},
                   log_metadata: %{
                     trace_id: "trc-db",
                     workspace_id: "workspace-1",
                     agent_id: "agent-1",
                     caller: "postgrest_client_test",
                     api_key: "metadata-secret"
                   }
                 )
      end)

    [started, completed] = decode_logged_jsons!(log, "trc-db")

    assert started["event"] == "postgrest_request_started"
    assert started["trace_id"] == "trc-db"
    assert started["workspace_id"] == "workspace-1"
    assert started["agent_id"] == "agent-1"
    assert started["caller"] == "postgrest_client_test"
    assert started["method"] == "GET"
    assert started["table"] == "work_items"
    assert started["query_shape"] == ["select:value", "state:eq"]
    assert started["api_key"] == "[REDACTED]"
    refute Map.has_key?(started, "payload")
    refute Map.has_key?(started, "headers")

    assert completed["event"] == "postgrest_request_completed"
    assert completed["status_code"] == 200
    assert completed["response_row_count"] == 2
    assert completed["duration_ms"] >= 0
    assert completed["retryable"] == false
  end

  test "POST applies prefer header", %{client: client} do
    parent = self()

    Req.Test.stub(__MODULE__, fn conn ->
      {:ok, body, conn} = Plug.Conn.read_body(conn)

      send(parent, {
        :request,
        conn.method,
        conn.request_path,
        List.keyfind(conn.req_headers, "prefer", 0),
        Jason.decode!(body)
      })

      Plug.Conn.send_resp(conn, 201, "")
    end)

    assert {:ok, _body} =
             PostgRESTClient.post(client, "comments", %{"body" => "hello"}, prefer: "return=minimal")

    assert_received {:request, "POST", "/rest/v1/comments", {"prefer", "return=minimal"}, %{"body" => "hello"}}
  end

  test "POST supports query parameters", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/broker_run"
      assert URI.decode_query(conn.query_string) == %{"select" => "run_id"}

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(201, Jason.encode!([%{"run_id" => "run-1"}]))
    end)

    assert {:ok, [%{"run_id" => "run-1"}]} =
             PostgRESTClient.post(client, "broker_run", %{"status" => "started"}, query: %{"select" => "run_id"})
  end

  test "upsert applies conflict and merge prefer headers", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      assert conn.method == "POST"
      assert conn.request_path == "/rest/v1/engine_instance"
      assert URI.decode_query(conn.query_string) == %{"on_conflict" => "instance_id"}

      prefer = Plug.Conn.get_req_header(conn, "prefer") |> List.first()
      assert prefer =~ "resolution=merge-duplicates"
      assert prefer =~ "return=representation"

      Plug.Conn.send_resp(conn, 201, "")
    end)

    assert {:ok, _body} =
             PostgRESTClient.upsert(client, "engine_instance", %{"instance_id" => "orch_1"}, "instance_id")
  end

  test "non-2xx responses use shared error shape", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(400, Jason.encode!(%{"message" => "bad request"}))
    end)

    log =
      capture_log(fn ->
        assert {:error, {:http_error, 400, %{"message" => "bad request"}}} =
                 PostgRESTClient.patch(client, "work_items", %{"id" => "eq.wi-1"}, %{"state" => "done"}, log_metadata: [trace_id: "trc-http-error"])
      end)

    [_started, failed] = decode_logged_jsons!(log, "trc-http-error")

    assert failed["event"] == "postgrest_request_failed"
    assert failed["trace_id"] == "trc-http-error"
    assert failed["status_code"] == 400
    assert failed["error_code"] == "db_http_error"
    assert failed["duration_ms"] >= 0
    assert failed["retryable"] == false
    refute inspect(failed) =~ "done"
  end

  test "request failures emit failed logs with stable error codes" do
    client =
      PostgRESTClient.new(
        %{endpoint: "http://127.0.0.1:9/rest/v1", api_key: "secret"},
        retry: false,
        connect_options: [timeout: 10],
        receive_timeout: 10
      )

    log =
      capture_log(fn ->
        assert {:error, {:request_failed, _reason}} =
                 PostgRESTClient.get(client, "work_items", %{"state" => "eq.todo"}, log_metadata: %{trace_id: "trc-request-failed"})
      end)

    [_started, failed] = decode_logged_jsons!(log, "trc-request-failed")

    assert failed["event"] == "postgrest_request_failed"
    assert failed["trace_id"] == "trc-request-failed"
    assert failed["error_code"] in ["db_request_failed", "db_timeout"]
    assert is_boolean(failed["retryable"])
    assert failed["duration_ms"] >= 0
  end

  defp decode_logged_jsons!(log, trace_id) do
    log
    |> String.split("\n", trim: true)
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/(\{.*\})/, line) do
        [_, json] -> [Jason.decode!(json)]
        _ -> []
      end
    end)
    |> Enum.filter(&(Map.get(&1, "trace_id") == trace_id))
  end

  test "falls back to process-dict trace_id when log_metadata omits it", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([]))
    end)

    previous = Process.get(:symphony_trace_id)
    Process.put(:symphony_trace_id, "trc-from-process")

    try do
      log =
        capture_log(fn ->
          assert {:ok, []} =
                   PostgRESTClient.get(client, "work_items", %{"state" => "eq.todo"},
                     log_metadata: %{caller: "process_dict_test"}
                   )
        end)

      [started, completed] = decode_logged_jsons!(log, "trc-from-process")

      assert started["event"] == "postgrest_request_started"
      assert started["trace_id"] == "trc-from-process"
      assert started["caller"] == "process_dict_test"
      refute Map.has_key?(started, "missing_required_fields")

      assert completed["event"] == "postgrest_request_completed"
      assert completed["trace_id"] == "trc-from-process"
    after
      case previous do
        nil -> Process.delete(:symphony_trace_id)
        value -> Process.put(:symphony_trace_id, value)
      end
    end
  end

  test "explicit log_metadata trace_id wins over process-dict trace_id", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([]))
    end)

    previous = Process.get(:symphony_trace_id)
    Process.put(:symphony_trace_id, "trc-process")

    try do
      log =
        capture_log(fn ->
          assert {:ok, []} =
                   PostgRESTClient.get(client, "work_items", %{"state" => "eq.todo"},
                     log_metadata: %{trace_id: "trc-explicit", caller: "explicit_wins_test"}
                   )
        end)

      assert log =~ ~s("trace_id":"trc-explicit")
      refute log =~ ~s("trace_id":"trc-process")
    after
      case previous do
        nil -> Process.delete(:symphony_trace_id)
        value -> Process.put(:symphony_trace_id, value)
      end
    end
  end

  test "request logs include caller context metadata", %{client: client} do
    Req.Test.stub(__MODULE__, fn conn ->
      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!([%{"id" => "wi-1"}]))
    end)

    log =
      capture_log([level: :debug], fn ->
        assert {:ok, [%{"id" => "wi-1"}]} =
                 PostgRESTClient.get(client, "work_items", %{"workspace_id" => "eq.workspace-1"},
                   log_metadata: %{
                     caller: "tracker.database.fetch_candidate_issues",
                     action: "tracker.database.fetch_candidate_issues",
                     workspace_id: "workspace-1",
                     trace_id: "trace-1"
                   }
                 )
      end)

    assert log =~ ~s("event":"postgrest_request_completed")
    assert log =~ ~s("caller":"tracker.database.fetch_candidate_issues")
    assert log =~ ~s("workspace_id":"workspace-1")
    assert log =~ ~s("trace_id":"trace-1")
    assert log =~ ~s("table":"work_items")
    assert log =~ ~s("query_shape":["workspace_id:eq"])
  end
end
