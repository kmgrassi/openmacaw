defmodule SymphonyElixir.Launcher.GatewayConfig.Resolved do
  @moduledoc """
  Resolved `gateway_config` row returned by `SymphonyElixir.Launcher.GatewayConfig.fetch/2`.

  `config_json` is the raw launch config payload the launcher merges into its
  orchestrator config. `config_hash` and `version` are the versioning fields the
  launcher later writes back through `gateway_config_state`.
  """

  @type t :: %__MODULE__{
          scope_type: String.t(),
          scope_id: String.t(),
          config_json: map(),
          config_hash: String.t(),
          version: integer()
        }

  @enforce_keys [:scope_type, :scope_id, :config_json, :config_hash, :version]
  defstruct [:scope_type, :scope_id, :config_json, :config_hash, :version]
end
