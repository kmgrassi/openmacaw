defmodule SymphonyElixir.ExecutionAdapter.LocalHelper do
  @moduledoc """
  Execution adapter marker for existing local helper/relay routing.

  This adapter deliberately does not dispatch work; existing local runner paths
  continue to own local relay execution. It gives cloud execution callers a
  contract-level way to select the local target without branching on runner
  internals.
  """

  @behaviour SymphonyElixir.ExecutionAdapter

  alias SymphonyElixir.ExecutionAdapter.Error

  @impl true
  def validate_config(_config), do: :ok

  @impl true
  def start_run(%{} = request) do
    with :ok <- validate_execution_mode(Map.get(request, :execution_mode)) do
      {:ok,
       %{
         adapter: "local_helper",
         status: "selected",
         run_id: Map.get(request, :run_id),
         target: "local_helper",
         metadata: %{
           "message" => "Existing LocalRelay runner routing remains responsible for execution."
         }
       }}
    end
  end

  defp validate_execution_mode(mode) when mode in [:planning_read_only, :coding_workspace_write], do: :ok

  defp validate_execution_mode(mode) do
    {:error,
     Error.new(:unsupported_execution_mode, "Unsupported execution mode for local helper adapter", %{
       execution_mode: inspect(mode),
       supported_modes: ["planning_read_only", "coding_workspace_write"]
     })}
  end
end
