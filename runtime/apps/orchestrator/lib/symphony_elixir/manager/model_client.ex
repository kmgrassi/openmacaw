defmodule SymphonyElixir.Manager.ModelClient do
  @moduledoc """
  Behaviour for manager model transports.

  The manager runner owns prompt loading, tool execution, and scheduler-facing
  result normalization. Model clients own provider or relay protocol details.
  """

  alias SymphonyElixir.WorkItem

  @callback create_response(session :: map(), request :: map(), attempt :: pos_integer()) ::
              {:ok, response :: map()} | {:error, term()}

  @callback initial_request(session :: map(), due_tasks_payload :: String.t(), work_item :: WorkItem.t()) ::
              map()

  @callback follow_up_request(session :: map(), response :: map(), tool_outputs :: [map()]) :: map()

  @callback output_texts(response :: map()) :: [String.t()]

  @callback tool_calls(response :: map()) :: [map()]

  @callback response_id(response :: map()) :: String.t() | nil
end
