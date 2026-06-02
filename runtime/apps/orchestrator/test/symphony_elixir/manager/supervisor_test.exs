defmodule SymphonyElixir.Manager.SupervisorTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Manager.Bootstrapper
  alias SymphonyElixir.Manager.Supervisor, as: ManagerSupervisor

  defmodule TestWorkspaces do
    @behaviour SymphonyElixir.Manager.Workspaces

    def list_active_workspace_ids do
      {:ok, Application.fetch_env!(:symphony_elixir, :test_manager_workspace_ids)}
    end
  end

  defmodule TestSessionResolver do
    @doc """
    Maps workspace_id to agent_id via app env. Tests put a map in
    :test_manager_session_identity to control which workspaces resolve to
    which agents (or to nothing).
    """
    def identity(workspace_id, _opts) do
      mapping = Application.get_env(:symphony_elixir, :test_manager_session_identity, %{})

      case Map.get(mapping, workspace_id) do
        agent_id when is_binary(agent_id) -> {:ok, %{agent_id: agent_id}}
        _ -> {:idle, :config_missing, %{status: :idle_awaiting_config}}
      end
    end

    def resolve(workspace_id, opts), do: identity(workspace_id, opts)
  end

  defmodule TestAgentInventory do
    alias SymphonyElixir.AgentInventory.Agent

    def list_agents do
      mapping = Application.get_env(:symphony_elixir, :test_manager_session_identity, %{})

      agents =
        Enum.map(mapping, fn {workspace_id, agent_id} ->
          %Agent{id: agent_id, workspace_id: workspace_id, type: "manager"}
        end)

      {:ok, agents}
    end
  end

  setup do
    supervisor_name = :"manager_supervisor_#{System.unique_integer([:positive])}"
    {:ok, supervisor} = ManagerSupervisor.start_link(name: supervisor_name)

    on_exit(fn ->
      safe_stop(supervisor)
      Application.delete_env(:symphony_elixir, :test_manager_workspace_ids)
      Application.delete_env(:symphony_elixir, :test_manager_session_identity)
    end)

    %{supervisor: supervisor_name}
  end

  test "startup sweep starts one scheduler per (workspace, agent) the resolver identifies", %{
    supervisor: supervisor
  } do
    Application.put_env(:symphony_elixir, :test_manager_workspace_ids, ["workspace-a", "workspace-b"])

    Application.put_env(:symphony_elixir, :test_manager_session_identity, %{
      "workspace-a" => "agent-a",
      "workspace-b" => "agent-b"
    })

    {:ok, bootstrapper} =
      Bootstrapper.start_link(
        name: :"manager_bootstrapper_#{System.unique_integer([:positive])}",
        manager_supervisor: supervisor,
        workspaces: TestWorkspaces,
        agent_inventory: TestAgentInventory,
        scheduler_opts: [schedule_first_tick: false],
        subscribe?: false
      )

    assert_eventually(fn ->
      assert {:ok, pid_a} = ManagerSupervisor.lookup("workspace-a", "agent-a")
      assert {:ok, pid_b} = ManagerSupervisor.lookup("workspace-b", "agent-b")
      assert Process.alive?(pid_a)
      assert Process.alive?(pid_b)
    end)

    GenServer.stop(bootstrapper)
  end

  test "sweep skips workspaces with no resolved manager agent", %{supervisor: supervisor} do
    Application.put_env(:symphony_elixir, :test_manager_workspace_ids, ["workspace-unconfigured"])
    Application.put_env(:symphony_elixir, :test_manager_session_identity, %{})

    {:ok, bootstrapper} =
      Bootstrapper.start_link(
        name: :"manager_bootstrapper_#{System.unique_integer([:positive])}",
        manager_supervisor: supervisor,
        workspaces: TestWorkspaces,
        agent_inventory: TestAgentInventory,
        scheduler_opts: [schedule_first_tick: false],
        subscribe?: false
      )

    Process.sleep(50)

    assert ManagerSupervisor.list_workspace_schedulers("workspace-unconfigured") == []

    GenServer.stop(bootstrapper)
  end

  test "scheduler restarts after an abnormal exit", %{supervisor: supervisor} do
    assert {:ok, pid} =
             ManagerSupervisor.ensure_scheduler("workspace-restart", "agent-restart",
               supervisor: supervisor,
               schedule_first_tick: false
             )

    Process.exit(pid, :kill)

    assert_eventually(fn ->
      assert {:ok, restarted} = ManagerSupervisor.lookup("workspace-restart", "agent-restart")
      assert restarted != pid
      assert Process.alive?(restarted)
    end)
  end

  test "workspace archived event stops every scheduler for that workspace", %{
    supervisor: supervisor
  } do
    assert {:ok, pid_a} =
             ManagerSupervisor.ensure_scheduler("workspace-archived", "agent-a",
               supervisor: supervisor,
               schedule_first_tick: false
             )

    assert {:ok, pid_b} =
             ManagerSupervisor.ensure_scheduler("workspace-archived", "agent-b",
               supervisor: supervisor,
               schedule_first_tick: false
             )

    {:ok, bootstrapper} =
      Bootstrapper.start_link(
        name: :"manager_bootstrapper_#{System.unique_integer([:positive])}",
        manager_supervisor: supervisor,
        workspaces: TestWorkspaces,
        session_resolver: TestSessionResolver,
        subscribe?: false,
        sweep?: false
      )

    send(bootstrapper, {:manager_workspace_archived, "workspace-archived"})

    assert_eventually(fn ->
      refute Process.alive?(pid_a)
      refute Process.alive?(pid_b)
      assert ManagerSupervisor.list_workspace_schedulers("workspace-archived") == []
    end)

    GenServer.stop(bootstrapper)
  end

  test "two manager agents in the same workspace get independent schedulers", %{
    supervisor: supervisor
  } do
    assert {:ok, pid_a} =
             ManagerSupervisor.ensure_scheduler("workspace-multi", "agent-a",
               supervisor: supervisor,
               schedule_first_tick: false
             )

    assert {:ok, pid_b} =
             ManagerSupervisor.ensure_scheduler("workspace-multi", "agent-b",
               supervisor: supervisor,
               schedule_first_tick: false
             )

    assert pid_a != pid_b
    assert Process.alive?(pid_a)
    assert Process.alive?(pid_b)

    schedulers = ManagerSupervisor.list_workspace_schedulers("workspace-multi")
    assert {"agent-a", pid_a} in schedulers
    assert {"agent-b", pid_b} in schedulers
  end

  defp assert_eventually(fun, attempts \\ 20)

  defp assert_eventually(fun, attempts) when attempts > 0 do
    fun.()
  rescue
    ExUnit.AssertionError ->
      Process.sleep(25)
      assert_eventually(fun, attempts - 1)
  end

  defp assert_eventually(fun, 0), do: fun.()

  defp safe_stop(pid) do
    if Process.alive?(pid) do
      try do
        GenServer.stop(pid)
      catch
        :exit, _reason -> :ok
      end
    end
  end
end
