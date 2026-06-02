defmodule SymphonyElixir.Planner.ModelClient do
  @moduledoc """
  Planner model client contract.

  Clients own provider-specific turn setup and tool-call transport while the
  runner owns lifecycle selection and the common `SymphonyElixir.Runner`
  boundary.
  """

  @callback start_session(config :: map(), workspace :: term()) :: {:ok, map()} | {:error, term()}
  @callback run_turn(session :: map(), prompt :: String.t(), work_item :: term()) ::
              {:ok, map()} | {:error, term()}
  @callback stop_session(session :: map()) :: :ok
  @callback ping(config :: map()) :: :ok | {:error, term()}
  @callback requires_workspace?() :: boolean()
end
