defmodule SymphonyElixir.Cutover.Decision do
  @moduledoc """
  Terminal decision emitted by the cutover walk and persisted for audit.
  """

  @enforce_keys [
    :workspace_id,
    :agent_id,
    :from_provider,
    :from_model,
    :trigger_error_code,
    :elapsed_ms,
    :outcome
  ]
  defstruct [
    :workspace_id,
    :agent_id,
    :work_item_id,
    :from_provider,
    :from_model,
    :from_credential_id,
    :to_provider,
    :to_model,
    :to_credential_id,
    :trigger_error_code,
    :trigger_status_code,
    :elapsed_ms,
    :outcome,
    :triggered_at,
    attempts: []
  ]

  @type outcome ::
          :fallback_succeeded
          | :fallback_failed
          | :escalated_floor
          | :escalated_exhausted
          | :skipped_no_adapter

  @type t :: %__MODULE__{
          workspace_id: String.t(),
          agent_id: String.t(),
          work_item_id: String.t() | nil,
          from_provider: String.t(),
          from_model: String.t(),
          from_credential_id: String.t() | nil,
          to_provider: String.t() | nil,
          to_model: String.t() | nil,
          to_credential_id: String.t() | nil,
          trigger_error_code: String.t(),
          trigger_status_code: non_neg_integer() | nil,
          elapsed_ms: non_neg_integer(),
          outcome: outcome(),
          triggered_at: DateTime.t() | nil,
          attempts: [map()]
        }
end
