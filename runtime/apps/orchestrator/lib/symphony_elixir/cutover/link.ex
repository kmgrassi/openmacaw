defmodule SymphonyElixir.Cutover.Link do
  @moduledoc """
  Normalized provider/model target in a cutover chain.
  """

  defstruct [
    :provider,
    :model,
    :credential_ref,
    :credential_id,
    :runner_kind,
    :position,
    adapter_available?: true,
    metadata: %{}
  ]

  @type t :: %__MODULE__{
          provider: String.t(),
          model: String.t() | nil,
          credential_ref: term(),
          credential_id: String.t() | nil,
          runner_kind: String.t() | nil,
          position: non_neg_integer(),
          adapter_available?: boolean(),
          metadata: map()
        }
end
