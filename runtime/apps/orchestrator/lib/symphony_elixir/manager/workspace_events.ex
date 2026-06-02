defmodule SymphonyElixir.Manager.WorkspaceEvents do
  @moduledoc """
  PubSub helpers for workspace lifecycle events consumed by the manager bootstrapper.
  """

  @pubsub SymphonyElixir.PubSub
  @topic "manager:workspaces"

  @type event :: {:manager_workspace_created, String.t()} | {:manager_workspace_archived, String.t()}

  @spec subscribe() :: :ok | {:error, term()}
  def subscribe do
    Phoenix.PubSub.subscribe(@pubsub, @topic)
  end

  @spec broadcast_created(String.t()) :: :ok
  def broadcast_created(workspace_id), do: broadcast({:manager_workspace_created, workspace_id})

  @spec broadcast_archived(String.t()) :: :ok
  def broadcast_archived(workspace_id), do: broadcast({:manager_workspace_archived, workspace_id})

  defp broadcast(message) do
    if Process.whereis(@pubsub) do
      Phoenix.PubSub.broadcast(@pubsub, @topic, message)
    end

    :ok
  end
end
