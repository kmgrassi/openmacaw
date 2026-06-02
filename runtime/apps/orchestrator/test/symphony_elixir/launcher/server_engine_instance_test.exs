defmodule SymphonyElixir.Launcher.ServerEngineInstanceTest do
  @moduledoc """
  Exercises the `engine_instance` writeback paths from the Launcher GenServer.

  Uses a synchronous dispatcher so Req.Test stubs (which are process-local)
  see the HTTP calls fired from `handle_call/2` and `handle_info/2` without
  having to cross a Task boundary.
  """

  use ExUnit.Case, async: false

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Launcher.EngineInstance
  alias SymphonyElixir.Launcher.Server

  @moduletag :launcher

  defmodule TestAgentInventory do
    @behaviour SymphonyElixir.AgentInventory

    alias SymphonyElixir.AgentInventory.Agent

    def list_agents do
      {:ok, Application.get_env(:symphony_elixir, :test_agent_inventory_agents, [])}
    end

    def get_agent(agent_id) do
      Application.get_env(:symphony_elixir, :test_agent_inventory_agents, [])
      |> Enum.find(&(&1.id == agent_id))
      |> case do
        %Agent{} = agent -> {:ok, agent}
        nil -> {:error, :not_found}
      end
    end

    def list_credentials(_agent_id), do: {:ok, []}
  end

  defp mock_starter(opts) do
    supervisor = Keyword.fetch!(opts, :supervisor)
    id = Keyword.fetch!(opts, :id)

    child_spec = %{
      id: :"mock_orch_#{id}",
      start: {Elixir.Agent, :start_link, [fn -> %{id: id} end]},
      restart: :temporary
    }

    DynamicSupervisor.start_child(supervisor, child_spec)
  end

  defp safe_stop(pid) do
    if Process.alive?(pid) do
      try do
        GenServer.stop(pid, :normal, 5_000)
      catch
        :exit, _ -> :ok
      end
    end
  end

  setup do
    # Test is async: false, so share Req.Test stubs set by this process with
    # the Server (and any Tasks) that run in their own processes.
    Req.Test.set_req_test_to_shared(%{})

    Application.put_env(:symphony_elixir, :agent_inventory_adapter, TestAgentInventory)
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [])
    Application.put_env(:symphony_elixir, :agent_launch_template, %{"tracker" => %{"kind" => "memory"}})

    # Sync dispatcher so Req.Test stubs owned by this test process receive
    # the launcher's engine_instance HTTP calls.
    Application.put_env(
      :symphony_elixir,
      :launcher_engine_instance_dispatcher,
      fn work ->
        work.()
        :ok
      end
    )

    Application.put_env(:symphony_elixir, :launcher_engine_instance_req_options, plug: {Req.Test, EngineInstance})

    Application.put_env(:symphony_elixir, :launcher_engine_instance,
      endpoint: "https://test.supabase.co/rest/v1",
      api_key: "test-api-key",
      table: "engine_instance",
      host: "test-host"
    )

    state_dir = Path.join(System.tmp_dir!(), "launcher_ei_test_#{:rand.uniform(999_999)}")
    File.mkdir_p!(state_dir)

    {:ok, cr_pid} = SymphonyElixir.Launcher.ConfigRegistry.start_link()

    {:ok, ds_pid} =
      DynamicSupervisor.start_link(
        name: SymphonyElixir.Launcher.DynamicSupervisor,
        strategy: :one_for_one
      )

    on_exit(fn ->
      Application.delete_env(:symphony_elixir, :agent_inventory_adapter)
      Application.delete_env(:symphony_elixir, :test_agent_inventory_agents)
      Application.delete_env(:symphony_elixir, :agent_launch_template)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance_dispatcher)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance_req_options)
      Application.delete_env(:symphony_elixir, :launcher_engine_instance)
      safe_stop(ds_pid)
      safe_stop(cr_pid)
      File.rm_rf!(state_dir)
    end)

    %{state_dir: state_dir, ds_pid: ds_pid}
  end

  defp start_server(opts) do
    defaults = [start_port: 19_000, starter: &mock_starter/1, heartbeat_ms: :infinity]
    {:ok, pid} = Server.start_link(Keyword.merge(defaults, opts))

    ExUnit.Callbacks.on_exit(fn ->
      safe_stop(pid)
    end)

    pid
  end

  defp put_agent(id, workspace_id \\ "workspace-1") do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [
      %Agent{
        id: id,
        name: "Builder",
        workspace_id: workspace_id,
        project_id: "project-1"
      }
    ])
  end

  defp put_custom_agent(%Agent{} = agent) do
    Application.put_env(:symphony_elixir, :test_agent_inventory_agents, [agent])
  end

  describe "start_agent" do
    test "upserts a running row with host, port, and agent scope", ctx do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "POST" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)
            send(test_pid, {:upsert, conn.method, conn.query_string, payload})
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1")

      assert {:ok, orchestrator} = Server.start_agent("agent-1")

      assert_received {:upsert, "POST", "on_conflict=instance_id", payload}
      assert payload["instance_id"] == orchestrator.id
      assert payload["agent_id"] == "agent-1"
      assert payload["workspace_id"] == "workspace-1"
      assert payload["host"] == "test-host"
      assert payload["port"] == orchestrator.port
      assert payload["role"] == "unified"
      assert payload["status"] == "running"
    end

    test "does not write when agent has no workspace_id", ctx do
      Req.Test.stub(EngineInstance, fn conn ->
        # Reconcile GET is allowed; writes are not.
        if conn.method == "GET" do
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
        else
          flunk("engine_instance should not be written when workspace_id is missing")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1", nil)

      assert {:ok, _} = Server.start_agent("agent-1")
    end

    test "planner-origin coding launch requires explicit plan or task IDs", ctx do
      Req.Test.stub(EngineInstance, fn conn ->
        if conn.method == "GET" do
          conn
          |> Plug.Conn.put_resp_content_type("application/json")
          |> Plug.Conn.send_resp(200, "[]")
        else
          flunk("engine_instance should not be written when handoff validation fails")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1")

      assert {:error, :explicit_plan_handoff_required} =
               Server.start_agent("agent-1", %{"source" => "planner"})

      assert Server.list_orchestrators() == []
    end

    test "approved planner handoff is injected into coding launch config", ctx do
      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "POST" ->
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1")

      assert {:ok, orchestrator} =
               Server.start_agent("agent-1", %{
                 "source" => "planner",
                 "approved_plan_id" => "plan-1",
                 "selected_task_ids" => ["task-1", "task-2"]
               })

      assert orchestrator.config["plan_handoff"] == %{
               "source" => "planner",
               "approved_plan_id" => "plan-1",
               "selected_task_ids" => ["task-1", "task-2"]
             }
    end

    test "planner handoff falls back past blank source and id fields", ctx do
      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "POST" ->
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1")

      assert {:ok, orchestrator} =
               Server.start_agent("agent-1", %{
                 "source" => "",
                 "launch_source" => "planner",
                 "approved_plan_id" => "",
                 "plan_id" => "plan-1",
                 "selected_task_ids" => [],
                 "task_id" => "task-1"
               })

      assert orchestrator.config["plan_handoff"] == %{
               "source" => "planner",
               "approved_plan_id" => "plan-1",
               "selected_task_ids" => ["task-1"]
             }
    end

    test "starting a planning agent does not require or start a coding handoff", ctx do
      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "POST" ->
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir)

      put_custom_agent(%Agent{
        id: "planner-1",
        name: "Planner",
        type: "planning",
        workspace_id: "workspace-1",
        project_id: "project-1"
      })

      assert {:ok, orchestrator} = Server.start_agent("planner-1", %{"source" => "planner"})

      assert orchestrator.type == "planning"
      refute Map.has_key?(orchestrator.config, "plan_handoff")
      assert length(Server.list_orchestrators()) == 1
    end
  end

  describe "stop_orchestrator" do
    test "PATCHes status to stopped", ctx do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        {body, conn} =
          if conn.method == "GET" do
            {nil, conn |> Plug.Conn.put_resp_content_type("application/json") |> Plug.Conn.send_resp(200, "[]")}
          else
            {:ok, raw, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(raw)

            conn =
              if conn.method == "PATCH" and conn.query_string =~ "workspace_id=" do
                conn
                |> Plug.Conn.put_resp_content_type("application/json")
                |> Plug.Conn.send_resp(200, "[]")
              else
                Plug.Conn.send_resp(conn, if(conn.method == "POST", do: 201, else: 204), "")
              end

            {payload, conn}
          end

        if body && not (conn.method == "PATCH" and conn.query_string =~ "workspace_id=") do
          send(test_pid, {conn.method, conn.query_string, body})
        end

        conn
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1")

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      # Drain the initial running upsert.
      assert_received {"POST", _, _}

      assert {:ok, _} = Server.stop_orchestrator(orchestrator.id)

      assert_received {"PATCH", query, %{"status" => "stopped"}}
      assert query == "instance_id=eq.#{orchestrator.id}"
    end
  end

  describe "crash handling" do
    test "transitions through restarting -> running", ctx do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)

            if conn.query_string =~ "workspace_id=" do
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")
            else
              send(test_pid, {"PATCH", payload["status"]})
              Plug.Conn.send_resp(conn, 204, "")
            end

          "POST" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)
            send(test_pid, {"POST", payload["status"]})
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      put_agent("agent-1")

      assert {:ok, orchestrator} = Server.start_agent("agent-1")
      assert_received {"POST", "running"}

      [{_id, internal}] =
        :sys.get_state(Server)
        |> Map.get(:orchestrators)
        |> Enum.to_list()

      Process.exit(internal.pid, :kill)
      # Give the Server time to handle the :DOWN message and restart.
      Process.sleep(150)

      # Restart path fires :restarting then :running via PATCH.
      assert_received {"PATCH", "restarting"}
      assert_received {"PATCH", "running"}

      assert hd(Server.list_orchestrators()).id == orchestrator.id
    end
  end

  describe "heartbeat" do
    test "emits heartbeat PATCH for each running orchestrator", ctx do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)

            if conn.query_string =~ "workspace_id=" do
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")
            else
              send(test_pid, {"PATCH", payload})
              Plug.Conn.send_resp(conn, 204, "")
            end

          "POST" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)
            send(test_pid, {"POST", payload})
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir, heartbeat_ms: 40)
      put_agent("agent-1")

      assert {:ok, _} = Server.start_agent("agent-1")
      # Drain the initial POST (upsert) so subsequent assertions are heartbeats.
      assert_received {"POST", _}

      # Wait for at least one scheduled heartbeat tick.
      Process.sleep(120)

      # Heartbeat PATCH carries last_health_at and updated_at, no status.
      assert_received {"PATCH", payload}
      assert is_binary(payload["last_health_at"])
      assert is_binary(payload["updated_at"])
      refute Map.has_key?(payload, "status")
    end

    test "binds heartbeat trace inside dispatched task", ctx do
      test_pid = self()

      Application.put_env(
        :symphony_elixir,
        :launcher_engine_instance_dispatcher,
        fn work ->
          {:ok, _pid} = Task.start(work)
          :ok
        end
      )

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(200, "[]")

          "PATCH" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)

            if conn.query_string =~ "workspace_id=" do
              conn
              |> Plug.Conn.put_resp_content_type("application/json")
              |> Plug.Conn.send_resp(200, "[]")
            else
              send(test_pid, {:heartbeat_trace, Process.get(:symphony_trace_id), payload})
              Plug.Conn.send_resp(conn, 204, "")
            end

          "POST" ->
            send(test_pid, :upsert_written)
            Plug.Conn.send_resp(conn, 201, "")
        end
      end)

      start_server(state_dir: ctx.state_dir, heartbeat_ms: :infinity)
      put_agent("agent-1")

      assert {:ok, _} = Server.start_agent("agent-1")
      assert_receive :upsert_written, 1_000

      send(Server, :heartbeat)

      assert_receive {:heartbeat_trace, trace_id, payload}, 1_000
      assert String.starts_with?(trace_id, "trc_")
      assert is_binary(payload["last_health_at"])
    end
  end

  describe "boot-time reconcile" do
    test "marks stale running rows on this host as failed", ctx do
      test_pid = self()

      Req.Test.stub(EngineInstance, fn conn ->
        case conn.method do
          "GET" ->
            send(test_pid, :reconcile_get)
            assert URI.decode_query(conn.query_string) == %{"host" => "eq.test-host"}

            conn
            |> Plug.Conn.put_resp_content_type("application/json")
            |> Plug.Conn.send_resp(
              200,
              Jason.encode!([
                %{"instance_id" => "orch_ghost", "host" => "test-host", "status" => "running"}
              ])
            )

          "PATCH" ->
            {:ok, body, conn} = Plug.Conn.read_body(conn)
            payload = Jason.decode!(body)
            send(test_pid, {:reconcile_patch, conn.query_string, payload["status"]})
            Plug.Conn.send_resp(conn, 204, "")
        end
      end)

      start_server(state_dir: ctx.state_dir)
      # Reconcile runs in handle_continue(:bootstrap) — a sync call flushes
      # the continue queue so reconcile completes before we assert.
      _ = Server.list_orchestrators()

      assert_received :reconcile_get
      assert_received {:reconcile_patch, "instance_id=eq.orch_ghost", "failed"}
    end

    test "no-ops when writeback is disabled", ctx do
      Application.delete_env(:symphony_elixir, :launcher_engine_instance)

      Req.Test.stub(EngineInstance, fn _conn ->
        flunk("no HTTP calls should be made when writeback is disabled")
      end)

      start_server(state_dir: ctx.state_dir)
      _ = Server.list_orchestrators()
    end
  end
end
