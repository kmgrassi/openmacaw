defmodule SymphonyElixir.AgentInventory do
  @moduledoc """
  Launcher-facing access to the persisted agent inventory.

  The database is the source of truth for which agents exist and the configuration
  attached to them. Runtime process state remains in the launcher/orchestrator.
  """

  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.AgentInventory.StoredCredential

  @callback list_agents() :: {:ok, [Agent.t()]} | {:error, term()}
  @callback get_agent(String.t()) :: {:ok, Agent.t()} | {:error, term()}
  @callback list_credentials(String.t()) :: {:ok, [StoredCredential.t()]} | {:error, term()}

  @spec list_agents() :: {:ok, [Agent.t()]} | {:error, term()}
  def list_agents do
    adapter().list_agents()
  end

  @spec get_agent(String.t()) :: {:ok, Agent.t()} | {:error, term()}
  def get_agent(agent_id) when is_binary(agent_id) do
    adapter().get_agent(agent_id)
  end

  @spec list_credentials(String.t()) :: {:ok, [StoredCredential.t()]} | {:error, term()}
  def list_credentials(agent_id) when is_binary(agent_id) do
    adapter().list_credentials(agent_id)
  end

  defp adapter do
    Application.get_env(
      :symphony_elixir,
      :agent_inventory_adapter,
      SymphonyElixir.AgentInventory.Database
    )
  end
end
