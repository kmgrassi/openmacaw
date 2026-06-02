defmodule SymphonyElixir.Launcher.ConfigRegistry do
  @moduledoc """
  ETS-backed registry that maps orchestrator instance IDs to their
  workflow file paths.

  When the Launcher starts multiple orchestrators in the same BEAM node,
  each needs its own workflow/config. This registry stores per-instance
  workflow paths so that `Workflow.workflow_file_path/0` can resolve
  the correct path for whichever orchestrator is calling it.

  ## How it works

  Before starting an orchestrator, the Starter calls `put/2` to register
  the orchestrator's process name with its workflow file path. The
  Orchestrator (and anything in its call stack) can then call `get/1`
  to retrieve its specific workflow path.

  The registry is stored in a named ETS table that's created by the
  Launcher.Supervisor (via this module's `start_link/0`).
  """

  use GenServer

  @table __MODULE__

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Register a workflow file path for an orchestrator instance.
  """
  @spec put(term(), String.t()) :: :ok
  def put(instance_id, workflow_path) when is_binary(workflow_path) do
    :ets.insert(@table, {instance_id, workflow_path})
    :ok
  end

  @doc """
  Look up the workflow file path for an orchestrator instance.
  """
  @spec get(term()) :: {:ok, String.t()} | :error
  def get(instance_id) do
    case :ets.lookup(@table, instance_id) do
      [{^instance_id, path}] -> {:ok, path}
      [] -> :error
    end
  rescue
    ArgumentError -> :error
  end

  @doc """
  Remove the workflow file path for an orchestrator instance.
  """
  @spec delete(term()) :: :ok
  def delete(instance_id) do
    :ets.delete(@table, instance_id)
    :ok
  rescue
    ArgumentError -> :ok
  end

  @impl true
  def init(_opts) do
    table = :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, %{table: table}}
  end
end
