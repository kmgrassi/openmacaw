defmodule SymphonyElixir.Gateway.SharedSessionKey do
  @moduledoc """
  Canonical session keys for shared human chat with an agent.

  Shared browser chat is partitioned by workspace and agent, not by the
  currently connected user. Individual message rows still carry `user_id`.
  """

  @spec for_agent(String.t(), String.t()) :: String.t()
  def for_agent(workspace_id, agent_id) when is_binary(workspace_id) and is_binary(agent_id) do
    "#{workspace_id}:#{agent_id}"
  end
end
