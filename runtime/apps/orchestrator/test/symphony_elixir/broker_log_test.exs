defmodule SymphonyElixir.BrokerLogTest do
  use ExUnit.Case, async: false
  import ExUnit.CaptureLog

  import ExUnit.CaptureLog

  alias SymphonyElixir.BrokerLog
  alias SymphonyElixir.Workflow
  alias SymphonyElixir.WorkItem

  setup do
    workflow_root =
      Path.join(System.tmp_dir!(), "symphony-broker-log-#{System.unique_integer([:positive])}")

    File.mkdir_p!(workflow_root)
    workflow_path = Path.join(workflow_root, "WORKFLOW.md")

    write_broker_workflow(workflow_path, stored_agent: true)

    Workflow.set_workflow_file_path(workflow_path)
    if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()

    Application.put_env(:symphony_elixir, :broker_log_req_options, plug: {Req.Test, BrokerLog})

    Application.put_env(:symphony_elixir, :broker_log,
      endpoint: "https://broker.example.com/rest/v1",
      api_key: "svc-key"
    )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :broker_log_req_options)
      Application.delete_env(:symphony_elixir, :broker_log)
      Workflow.clear_workflow_file_path()
      if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()
      File.rm_rf!(workflow_root)
    end)

    %{workflow_path: workflow_path}
  end

  defp write_broker_workflow(path, opts) do
    stored_agent_section =
      if Keyword.get(opts, :stored_agent, true) do
        """
        stored_agent:
          id: agent-1
          workspace_id: workspace-1
          name: Builder
        """
      else
        ""
      end

    File.write!(path, """
    ---
    tracker:
      kind: database
      endpoint: "https://tracker.example.com/rest/v1"
      api_key: "svc-key"
      table: work_items
    #{stored_agent_section}---
    prompt body
    """)

    if Process.whereis(SymphonyElixir.WorkflowStore), do: SymphonyElixir.WorkflowStore.force_reload()
    :ok
  end

  describe "enabled?/0" do
    test "returns true when both env vars and stored_agent are set" do
      assert BrokerLog.enabled?() == true
    end

    test "returns false when Supabase credentials are missing" do
      Application.delete_env(:symphony_elixir, :broker_log)

      assert BrokerLog.enabled?() == false
    end
  end

  describe "start_run/1" do
    test "inserts broker_run and returns the generated run_id" do
      parent = self()

      Req.Test.stub(BrokerLog, fn conn ->
        assert conn.method == "POST"
        assert conn.request_path == "/rest/v1/broker_run"
        assert URI.decode_query(conn.query_string)["select"] == "run_id"

        {:ok, body, conn} = Plug.Conn.read_body(conn)
        decoded = Jason.decode!(body)
        send(parent, {:broker_run_payload, decoded})

        conn
        |> Plug.Conn.put_resp_content_type("application/json")
        |> Plug.Conn.send_resp(201, Jason.encode!([%{"run_id" => "run-abc"}]))
      end)

      issue = %WorkItem{
        id: "item-1",
        identifier: "KG-42",
        title: "Ship OR-6",
        state: "in_progress",
        source: "database"
      }

      log =
        capture_log([level: :debug], fn ->
          assert {:ok, "run-abc"} =
                   BrokerLog.start_run(
                     issue: issue,
                     attempt: 1,
                     worker_host: "worker-a",
                     workspace_path: "/tmp/symphony/123"
                   )
        end)

      assert_received {:broker_run_payload, payload}
      assert payload["agent_id"] == "agent-1"
      assert payload["workspace_id"] == "workspace-1"
      assert payload["status"] == "started"
      assert payload["attempt"] == 1
      assert payload["tracker_kind"] == "database"
      assert payload["issue_identifier"] == "KG-42"
      assert payload["issue_state"] == "in_progress"
      assert payload["workspace_path"] == "/tmp/symphony/123"
      assert payload["input"]["worker_host"] == "worker-a"
      assert log =~ ~s("caller":"broker_log.start_run")
      assert log =~ ~s("workspace_id":"workspace-1")
      assert log =~ ~s("agent_id":"agent-1")
    end

    test "returns :disabled when stored_agent is missing", ctx do
      write_broker_workflow(ctx.workflow_path, stored_agent: false)

      assert :disabled =
               BrokerLog.start_run(
                 issue: %WorkItem{id: "item-1", identifier: "KG-42", state: "todo"},
                 attempt: 0
               )
    end

    test "returns :disabled when Supabase credentials are absent" do
      Application.delete_env(:symphony_elixir, :broker_log)

      assert :disabled =
               BrokerLog.start_run(issue: %WorkItem{id: "item-1", identifier: "KG-42", state: "todo"})
    end
  end

  describe "record_turn/2" do
    test "inserts a broker_task row with token counts and last_event" do
      parent = self()

      Req.Test.stub(BrokerLog, fn conn ->
        assert conn.method == "POST"
        assert conn.request_path == "/rest/v1/broker_task"

        {:ok, body, conn} = Plug.Conn.read_body(conn)
        decoded = Jason.decode!(body)
        send(parent, {:broker_task_payload, decoded})

        Plug.Conn.send_resp(conn, 201, "")
      end)

      assert :ok =
               BrokerLog.record_turn("run-abc",
                 input_tokens: 120,
                 output_tokens: 40,
                 total_tokens: 160,
                 last_event: :turn_completed,
                 attempt: 2
               )

      assert_received {:broker_task_payload, payload}
      assert payload["run_id"] == "run-abc"
      assert payload["type"] == "turn"
      assert payload["input_tokens"] == 120
      assert payload["output_tokens"] == 40
      assert payload["total_tokens"] == 160
      assert payload["last_event"] == "turn_completed"
      assert payload["attempt"] == 2
    end

    test "is a no-op when credentials are missing" do
      Application.delete_env(:symphony_elixir, :broker_log)

      assert :disabled = BrokerLog.record_turn("run-abc", input_tokens: 1)
    end

    test "logs structured manager broker persistence failures" do
      Req.Test.stub(BrokerLog, fn conn ->
        assert conn.method == "POST"
        assert conn.request_path == "/rest/v1/broker_task"

        Plug.Conn.send_resp(conn, 429, "rate limited")
      end)

      log =
        capture_log(fn ->
          assert {:error, {:http_error, 429, "rate limited"}} =
                   BrokerLog.record_turn("run-abc", attempt: 3)
        end)

      payload = logged_json_payload!(log, "broker_persistence_failed")

      assert payload["error_code"] == "broker_persistence_failed"
      assert payload["operation"] == "record_turn"
      assert payload["table"] == "broker_task"
      assert payload["run_id"] == "run-abc"
      assert payload["turn_number"] == 3
      assert payload["non_fatal"] == true
      assert payload["retryable"] == true
      assert payload["reason"] =~ "rate limited"
    end
  end

  describe "finish_run/2" do
    test "patches broker_run with completion metadata" do
      parent = self()

      Req.Test.stub(BrokerLog, fn conn ->
        assert conn.method == "PATCH"
        assert conn.request_path == "/rest/v1/broker_run"
        assert URI.decode_query(conn.query_string)["run_id"] == "eq.run-abc"

        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:broker_run_patch, Jason.decode!(body)})

        Plug.Conn.send_resp(conn, 204, "")
      end)

      assert :ok =
               BrokerLog.finish_run("run-abc",
                 status: "failed",
                 terminal_reason: "turn_timeout",
                 error: "timed out"
               )

      assert_received {:broker_run_patch, payload}
      assert payload["status"] == "failed"
      assert payload["terminal_reason"] == "turn_timeout"
      assert payload["error"] == "timed out"
      assert is_binary(payload["completed_at"])
    end

    test "defaults status to completed when not provided" do
      parent = self()

      Req.Test.stub(BrokerLog, fn conn ->
        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:broker_run_patch, Jason.decode!(body)})
        Plug.Conn.send_resp(conn, 204, "")
      end)

      assert :ok = BrokerLog.finish_run("run-abc", [])

      assert_received {:broker_run_patch, payload}
      assert payload["status"] == "completed"
    end
  end

  describe "reconcile_orphans/0" do
    test "patches started runs for this agent to failed/orphaned" do
      parent = self()

      Req.Test.stub(BrokerLog, fn conn ->
        assert conn.method == "PATCH"
        assert conn.request_path == "/rest/v1/broker_run"

        params = URI.decode_query(conn.query_string)
        assert params["agent_id"] == "eq.agent-1"
        assert params["status"] == "eq.started"

        {:ok, body, conn} = Plug.Conn.read_body(conn)
        send(parent, {:orphans_patch, Jason.decode!(body)})

        Plug.Conn.send_resp(conn, 204, "")
      end)

      assert :ok = BrokerLog.reconcile_orphans()

      assert_received {:orphans_patch, payload}
      assert payload["status"] == "failed"
      assert payload["terminal_reason"] == "orphaned"
      assert is_binary(payload["completed_at"])
    end

    test "returns :disabled when stored_agent missing", ctx do
      write_broker_workflow(ctx.workflow_path, stored_agent: false)

      assert :disabled = BrokerLog.reconcile_orphans()
    end
  end

  defp logged_json_payload!(log, event) do
    log
    |> String.split("\n", trim: true)
    |> Enum.find_value(fn line ->
      with [_, json] <- Regex.run(~r/(\{.*\})/, line),
           {:ok, payload} <- Jason.decode(json),
           ^event <- Map.get(payload, "event") do
        payload
      else
        _ -> nil
      end
    end) || flunk("expected #{event} JSON log in:\n#{log}")
  end
end
