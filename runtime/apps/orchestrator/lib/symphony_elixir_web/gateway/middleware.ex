defmodule SymphonyElixirWeb.Gateway.Middleware do
  @moduledoc """
  Small validation and normalization helpers for the runtime gateway.
  """

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.Agent
  alias SymphonyElixir.RuntimeLog

  @type scope :: %{
          required(:agent_id) => String.t(),
          required(:workspace_id) => String.t(),
          optional(:session_key) => String.t(),
          optional(atom()) => term()
        }
  @type normalized_error :: %{required(:code) => String.t(), required(:message) => String.t()}

  @spec require_scope(%{optional(:scope) => scope()} | scope() | nil, map() | nil) ::
          {:ok, scope()} | {:error, :runtime_scope_required | :scope_mismatch}
  def require_scope(%{scope: scope}, params), do: require_scope(scope, params)

  def require_scope(nil, _params), do: {:error, :runtime_scope_required}

  def require_scope(scope, %{"agent_id" => agent_id, "workspace_id" => workspace_id}) do
    if scope.agent_id == agent_id and scope.workspace_id == workspace_id do
      {:ok, scope}
    else
      {:error, :scope_mismatch}
    end
  end

  def require_scope(_scope, _params), do: {:error, :runtime_scope_required}

  @spec fetch_agent(String.t()) :: {:ok, Agent.t()} | {:error, term()}
  def fetch_agent(agent_id) do
    case AgentInventory.get_agent(agent_id) do
      {:ok, agent} -> {:ok, agent}
      {:error, :not_found} -> {:error, :agent_not_found}
      {:error, reason} -> {:error, reason}
    end
  rescue
    error in [ArgumentError] ->
      RuntimeLog.log(:warning, :gateway_agent_inventory_lookup_failed, %{
        agent_id: agent_id,
        error_code: "agent_inventory_unavailable",
        reason: Exception.message(error),
        retryable: false
      })

      {:error, :agent_inventory_unavailable}
  end

  @spec agent_or_placeholder(String.t()) :: Agent.t() | map()
  def agent_or_placeholder(agent_id) do
    case fetch_agent(agent_id) do
      {:ok, agent} -> agent
      _ -> %{id: agent_id, name: agent_id, slug: agent_id, model_settings: %{}, context: nil}
    end
  end

  @spec normalize_error(term()) :: normalized_error()
  def normalize_error(:runtime_scope_required),
    do: %{code: "runtime_scope_required", message: "runtime scope requires agent_id, workspace_id, and user_id"}

  def normalize_error(:scope_mismatch),
    do: %{code: "scope_missing", message: "request scope does not match connection scope"}

  def normalize_error(:agent_not_found),
    do: %{code: "agent_not_found", message: "agent not found"}

  def normalize_error(:agent_inventory_unavailable),
    do: %{code: "agent_inventory_unavailable", message: "agent inventory is not configured"}

  def normalize_error(:run_already_active),
    do: %{code: "rate_limited", message: "a chat run is already active for this session"}

  def normalize_error(:session_not_found),
    do: %{code: "session_not_found", message: "session not found"}

  def normalize_error(:run_not_found),
    do: %{code: "session_not_found", message: "run not found"}

  def normalize_error(:config_conflict),
    do: %{code: "config_conflict", message: "configuration changed since it was loaded"}

  def normalize_error(reason), do: %{code: "internal_error", message: error_message(reason)}

  @spec error_message(term()) :: String.t()
  def error_message(reason) when is_binary(reason), do: reason
  def error_message(reason) when is_atom(reason), do: Atom.to_string(reason)
  def error_message(reason), do: inspect(reason)

  @spec error_code(term()) :: String.t()
  def error_code(:agent_not_found), do: "agent_not_found"
  def error_code(_reason), do: "runtime_error"
end
