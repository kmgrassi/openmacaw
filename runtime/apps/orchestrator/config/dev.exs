import Config

# ---------------------------------------------------------------------------
# Local-relay dev token for the local runtime helper.
# This config is only loaded in dev — production uses the DB-backed
# TokenValidator adapter instead.
#
# Token string: lrh_dev_local_token_2026
# Generate hash: echo -n "lrh_dev_local_token_2026" | shasum -a 256 | cut -d' ' -f1
# ---------------------------------------------------------------------------
config :symphony_elixir,
  local_relay_token_hashes: %{
    "6e0a70c5748fda51459787bd207e332b651f060edf0c6258f933aa230f4d6ef3" => %{
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
