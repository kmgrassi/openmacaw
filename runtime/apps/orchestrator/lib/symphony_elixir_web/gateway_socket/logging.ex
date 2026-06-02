defmodule SymphonyElixirWeb.GatewaySocket.Logging do
  @moduledoc false

  alias SymphonyElixir.RuntimeLog

  @spec log(Logger.level(), String.t() | atom(), map(), map()) :: :ok
  def log(level, event, %{scope: scope} = state, fields) do
    log(level, event, scope, state.trace_id, state.connection_id, fields)
  end

  @spec log(Logger.level(), String.t() | atom(), map() | nil, String.t() | nil, String.t() | nil, map()) :: :ok
  def log(level, event, scope, trace_id, connection_id, fields) do
    RuntimeLog.log(
      level,
      event,
      RuntimeLog.scope_fields(scope)
      |> Map.merge(%{trace_id: trace_id, connection_id: connection_id})
      |> Map.merge(fields)
    )
  end
end
