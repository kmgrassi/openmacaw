defmodule SymphonyElixir.Manager.Bootstrapper do
  @moduledoc """
  Starts/stops per-(workspace, agent) manager schedulers from DB state
  and workspace events.

  Resolves manager agents from the canonical agent inventory before starting
  schedulers.
  """

  use GenServer

  require Logger

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.Manager.Supervisor, as: ManagerSupervisor
  alias SymphonyElixir.Manager.WorkspaceEvents
  alias SymphonyElixir.Manager.Workspaces
  alias SymphonyElixir.RuntimeLog

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @impl true
  def init(opts) do
    state = %{
      manager_supervisor: Keyword.get(opts, :manager_supervisor, ManagerSupervisor),
      workspaces: Keyword.get(opts, :workspaces, Workspaces),
      agent_inventory: Keyword.get(opts, :agent_inventory, AgentInventory),
      scheduler_opts: Keyword.get(opts, :scheduler_opts, []),
      subscribe?: Keyword.get(opts, :subscribe?, true),
      sweep?: Keyword.get(opts, :sweep?, true)
    }

    if state.subscribe? do
      case WorkspaceEvents.subscribe() do
        :ok -> :ok
        {:error, reason} -> Logger.warning("Manager bootstrapper could not subscribe to workspace events: #{inspect(reason)}")
      end
    end

    if state.sweep?, do: send(self(), :sweep)

    {:ok, state}
  end

  @impl true
  def handle_info(:sweep, state) do
    RuntimeLog.with_operation_trace_id(nil, fn ->
      case state.workspaces.list_active_workspace_ids() do
        {:ok, workspace_ids} ->
          Enum.each(workspace_ids, &ensure_workspace_schedulers(&1, state))

        {:error, reason} ->
          Logger.warning("Manager bootstrap workspace sweep failed: #{inspect(reason)}")
      end
    end)

    {:noreply, state}
  end

  def handle_info({:manager_workspace_created, workspace_id}, state) do
    RuntimeLog.with_operation_trace_id(nil, fn ->
      ensure_workspace_schedulers(workspace_id, state)
    end)

    {:noreply, state}
  end

  def handle_info({:manager_workspace_archived, workspace_id}, state) do
    RuntimeLog.with_operation_trace_id(nil, fn ->
      stop_workspace_schedulers(workspace_id, state)
    end)

    {:noreply, state}
  end

  def handle_info(_message, state), do: {:noreply, state}

  defp ensure_workspace_schedulers(workspace_id, state) do
    Enum.each(workspace_manager_agent_ids(workspace_id, state), fn agent_id ->
      ensure_scheduler(workspace_id, agent_id, state)
    end)
  end

  defp workspace_manager_agent_ids(workspace_id, state) do
    case state.agent_inventory.list_agents() do
      {:ok, agents} when is_list(agents) ->
        agents
        |> Enum.filter(&manager_agent_for_workspace?(&1, workspace_id))
        |> Enum.map(& &1.id)
        |> Enum.filter(&(is_binary(&1) and &1 != ""))

      {:error, reason} ->
        Logger.warning(
          "Manager bootstrapper agent lookup failed for workspace_id=#{inspect(workspace_id)}: #{inspect(reason)}"
        )

        []
    end
  end

  defp manager_agent_for_workspace?(%Agent{type: type, workspace_id: workspace_id}, workspace_id) do
    Agent.kind(type) == "manager"
  end

  defp manager_agent_for_workspace?(_agent, _workspace_id), do: false

  defp ensure_scheduler(workspace_id, agent_id, state) do
    opts = Keyword.put(state.scheduler_opts, :supervisor, state.manager_supervisor)

    case ManagerSupervisor.ensure_scheduler(workspace_id, agent_id, opts) do
      {:ok, _pid} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Manager scheduler start failed for workspace_id=#{inspect(workspace_id)} agent_id=#{inspect(agent_id)}: #{inspect(reason)}"
        )
    end
  end

  defp stop_workspace_schedulers(workspace_id, state) do
    ManagerSupervisor.stop_workspace(workspace_id, supervisor: state.manager_supervisor)
  end
end
