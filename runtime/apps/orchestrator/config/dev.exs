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
      workspace_id: "dev-workspace",
      machine_id: "dev-machine",
      token_id: "dev-token",
      runner_kinds: ["openai_compatible"],
      revoked?: false
    }
  }
