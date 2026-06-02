defmodule SymphonyElixir.AgentInventory.StoredCredential do
  @moduledoc """
  Redacted launcher-side view of a credential row from Supabase.
  """

  @type t :: %__MODULE__{
          id: String.t(),
          agent_id: String.t() | nil,
          workspace_id: String.t() | nil,
          provider: String.t() | nil,
          label: String.t(),
          env_var: String.t(),
          updated_at: String.t() | nil,
          launchable_kind: String.t() | nil,
          has_secret: boolean(),
          secret_value: String.t() | nil,
          secret_ref: String.t() | nil,
          aliases: [String.t()]
        }

  defstruct [
    :id,
    :agent_id,
    :workspace_id,
    :provider,
    :label,
    :env_var,
    :updated_at,
    :launchable_kind,
    has_secret: false,
    secret_value: nil,
    secret_ref: nil,
    aliases: []
  ]

  @spec to_public_map(t()) :: map()
  def to_public_map(%__MODULE__{} = credential) do
    %{
      id: credential.id,
      agent_id: credential.agent_id,
      workspace_id: credential.workspace_id,
      provider: credential.provider,
      label: credential.label,
      env_var: credential.env_var,
      updated_at: credential.updated_at,
      launchable_kind: credential.launchable_kind,
      has_secret: credential.has_secret
    }
  end
end
