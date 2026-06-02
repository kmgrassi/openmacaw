defmodule SymphonyElixir.Manager.Supervisor do
  @moduledoc """
  Dynamic supervisor for per-(workspace, agent) manager schedulers.

  Each manager agent in a workspace gets its own scheduler GenServer.
  The bootstrapper resolves which agent(s) are configured per workspace
  and starts schedulers via `ensure_scheduler/3`.
  """

  use DynamicSupervisor

  alias SymphonyElixir.Manager.Scheduler

  @registry SymphonyElixir.Manager.Scheduler.Registry

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    DynamicSupervisor.start_link(__MODULE__, opts, name: name)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end

  @spec ensure_scheduler(String.t(), String.t(), keyword()) :: DynamicSupervisor.on_start_child()
  def ensure_scheduler(workspace_id, agent_id, opts \\ [])

  def ensure_scheduler(workspace_id, agent_id, opts)
      when is_binary(workspace_id) and workspace_id != "" and is_binary(agent_id) and agent_id != "" do
    supervisor = Keyword.get(opts, :supervisor, __MODULE__)

    case lookup(workspace_id, agent_id) do
      {:ok, pid} ->
        {:ok, pid}

      :error ->
        child_opts =
          opts
          |> Keyword.drop([:supervisor])
          |> Keyword.put(:workspace_id, workspace_id)
          |> Keyword.put(:agent_id, agent_id)

        case DynamicSupervisor.start_child(supervisor, {Scheduler, child_opts}) do
          {:ok, pid} ->
            {:ok, pid}

          {:error, {:already_started, pid}} ->
            {:ok, pid}

          other ->
            other
        end
    end
  end

  def ensure_scheduler(_workspace_id, _agent_id, _opts), do: {:error, :invalid_scheduler_key}

  @spec stop_scheduler(String.t(), String.t(), keyword()) :: :ok | {:error, :not_found | term()}
  def stop_scheduler(workspace_id, agent_id, opts \\ [])

  def stop_scheduler(workspace_id, agent_id, opts)
      when is_binary(workspace_id) and workspace_id != "" and is_binary(agent_id) and agent_id != "" do
    supervisor = Keyword.get(opts, :supervisor, __MODULE__)

    case lookup(workspace_id, agent_id) do
      {:ok, pid} -> DynamicSupervisor.terminate_child(supervisor, pid)
      :error -> {:error, :not_found}
    end
  end

  def stop_scheduler(_workspace_id, _agent_id, _opts), do: {:error, :invalid_scheduler_key}

  @spec stop_workspace(String.t(), keyword()) :: :ok
  @doc """
  Stop every scheduler for the given workspace, regardless of agent.

  Used by the workspace-archived event in `Manager.Bootstrapper`.
  """
  def stop_workspace(workspace_id, opts \\ [])

  def stop_workspace(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    Enum.each(list_workspace_schedulers(workspace_id), fn {agent_id, _pid} ->
      stop_scheduler(workspace_id, agent_id, opts)
    end)
  end

  def stop_workspace(_workspace_id, _opts), do: :ok

  @spec status(String.t(), String.t()) ::
          {:ok, SymphonyElixir.Manager.Scheduler.status()} | {:error, :not_found | term()}
  def status(workspace_id, agent_id)
      when is_binary(workspace_id) and workspace_id != "" and is_binary(agent_id) and agent_id != "" do
    case lookup(workspace_id, agent_id) do
      {:ok, pid} -> {:ok, Scheduler.status(pid)}
      :error -> {:error, :not_found}
    end
  catch
    :exit, reason -> {:error, reason}
  end

  def status(_workspace_id, _agent_id), do: {:error, :invalid_scheduler_key}

  @spec tick(String.t(), String.t(), timeout()) ::
          {:ok, map()} | {:error, :not_found | term()}
  def tick(workspace_id, agent_id, timeout \\ 305_000)

  def tick(workspace_id, agent_id, timeout)
      when is_binary(workspace_id) and workspace_id != "" and is_binary(agent_id) and agent_id != "" do
    case lookup(workspace_id, agent_id) do
      {:ok, pid} -> {:ok, Scheduler.tick(pid, timeout)}
      :error -> {:error, :not_found}
    end
  catch
    :exit, reason -> {:error, reason}
  end

  def tick(_workspace_id, _agent_id, _timeout), do: {:error, :invalid_scheduler_key}

  @spec lookup(String.t(), String.t()) :: {:ok, pid()} | :error
  def lookup(workspace_id, agent_id) when is_binary(workspace_id) and is_binary(agent_id) do
    case Registry.lookup(@registry, {:manager_scheduler, workspace_id, agent_id}) do
      [{pid, _value}] -> {:ok, pid}
      [] -> :error
    end
  end

  @spec list_workspace_schedulers(String.t()) :: [{agent_id :: String.t(), pid()}]
  def list_workspace_schedulers(workspace_id) when is_binary(workspace_id) do
    Registry.select(@registry, [
      {{{:manager_scheduler, :"$1", :"$2"}, :"$3", :_}, [{:==, :"$1", workspace_id}],
       [{{:"$2", :"$3"}}]}
    ])
  end

  @spec via(String.t(), String.t()) ::
          {:via, Registry, {module(), {:manager_scheduler, String.t(), String.t()}}}
  def via(workspace_id, agent_id), do: Scheduler.via_tuple(workspace_id, agent_id, @registry)
end
