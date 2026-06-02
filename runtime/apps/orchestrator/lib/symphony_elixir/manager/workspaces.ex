defmodule SymphonyElixir.Manager.Workspaces do
  @moduledoc """
  Source of workspace ids that should have a manager scheduler.
  """

  @callback list_active_workspace_ids() :: {:ok, [String.t()]} | {:error, term()}

  @spec list_active_workspace_ids() :: {:ok, [String.t()]} | {:error, term()}
  def list_active_workspace_ids do
    adapter().list_active_workspace_ids()
  end

  defp adapter do
    Application.get_env(
      :symphony_elixir,
      :manager_workspaces_adapter,
      SymphonyElixir.Manager.Workspaces.Database
    )
  end
end
