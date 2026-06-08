import Config

# ---------------------------------------------------------------------------
# Local-relay dev token for the local runtime helper.
# This config is only loaded in dev — production uses the DB-backed
# TokenValidator adapter instead.
#
# The accepted hash is derived from the SAME LOCAL_RELAY_DEV_TOKEN the platform
# API hands the helper (platform/apps/api/.../tokens.ts, defaulted in
# platform/scripts/dev.sh), so the issued token and the accepted hash never
# drift — including when the variable is overridden. Defaults to
# lrh_dev_local_token_2026. Both processes must see the same value (export the
# override, or rely on the default).
# ---------------------------------------------------------------------------
dev_relay_token = System.get_env("LOCAL_RELAY_DEV_TOKEN", "lrh_dev_local_token_2026")
dev_relay_token_hash = :crypto.hash(:sha256, dev_relay_token) |> Base.encode16(case: :lower)

config :symphony_elixir,
  local_relay_token_hashes: %{
    dev_relay_token_hash => %{
      # workspace_id / machine_id are left nil so this single dev token validates
      # for whatever workspace the local platform registers (a real UUID, not the
      # literal "dev-workspace"). The validator skips the match when the bound
      # value is nil, and the socket falls back to the frame's real ids for
      # presence/registry — so identity is still correct.
      workspace_id: nil,
      machine_id: nil,
      token_id: "dev-token",
      runner_kinds: ["openai_compatible"],
      revoked?: false
    }
  }
