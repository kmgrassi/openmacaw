defmodule SymphonyElixir.Launcher.GatewayConfig do
  @moduledoc """
  Launcher-facing access to Supabase `gateway_config` and `gateway_config_state`.

  Resolution keys follow the platform convention that `gateway_config.scope_type` is a
  plain string (no enum constraint). For launcher-driven agent starts we use:

    * `scope_type = "agent"`, `scope_id = <agent.id>` — per-agent launch config.
      Primary resolution target.
    * `scope_type = "workspace"`, `scope_id = <workspace.id>` — workspace-wide
      defaults for agents in that workspace. Optional; inherited when no agent-scoped
      row exists.

  The launcher resolves configs in this order on start:

      ("agent", agent_id) -> ("workspace", workspace_id) -> local template (dev only)

  After a start attempt, the launcher writes `gateway_config_state` with the applied
  hash/version and `last_apply_status = "ok" | "error"`. The row is keyed by
  `(scope_type, scope_id)` and links the `broker_instance_id` (the launcher-generated
  `engine_instance.instance_id` from OR-4) to the configured scope.
  """

  alias SymphonyElixir.Launcher.GatewayConfig.Resolved

  @type scope_type :: String.t()
  @type scope_id :: String.t()
  @type fetch_result :: {:ok, Resolved.t()} | {:error, term()}

  @callback fetch(scope_type(), scope_id()) :: fetch_result()
  @callback record_apply_state(scope_type(), scope_id(), :ok | :error, keyword()) ::
              :ok | {:error, term()}

  @spec fetch(scope_type(), scope_id()) :: fetch_result()
  def fetch(scope_type, scope_id)
      when is_binary(scope_type) and is_binary(scope_id) and scope_type != "" and scope_id != "" do
    adapter().fetch(scope_type, scope_id)
  end

  def fetch(_scope_type, _scope_id), do: {:error, :invalid_scope}

  @spec record_apply_state(scope_type(), scope_id(), :ok | :error, keyword()) ::
          :ok | {:error, term()}
  def record_apply_state(scope_type, scope_id, status, opts \\ [])
      when is_binary(scope_type) and is_binary(scope_id) and status in [:ok, :error] do
    adapter().record_apply_state(scope_type, scope_id, status, opts)
  end

  defp adapter do
    Application.get_env(
      :symphony_elixir,
      :launcher_gateway_config_adapter,
      SymphonyElixir.Launcher.GatewayConfig.Database
    )
  end
end
