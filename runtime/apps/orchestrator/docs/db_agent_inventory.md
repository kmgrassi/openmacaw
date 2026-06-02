# DB Agent Inventory

This slice makes the launcher read agent inventory from Supabase while keeping runtime process
state in the launcher/orchestrator.

## Boundary

- Supabase `agent` table is the source of truth for:
  - agent identity
  - workspace/project ownership
  - model settings
  - tool policy
- Supabase `credential` table is the source of truth for:
  - stored provider credential presence
  - redacted credential metadata shown to the UI
- Launcher is the source of truth for:
  - running orchestrators
  - runtime port/session reuse
  - process health

## Endpoints

- `GET /agents`
  - lists stored agents from Supabase
  - includes `has_credentials`
  - does not expose raw secrets
- `GET /agents/:id`
  - returns one stored agent
- `GET /agents/:id/credentials`
  - returns redacted stored credential descriptors for that agent
- `POST /agents/:id/start`
  - loads the agent from Supabase
  - reuses an already-running orchestrator for that agent if present
  - otherwise starts a new orchestrator from the launcher-side template

## Required config

Supabase access:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional launcher config:

- `config :symphony_elixir, :agent_inventory, ...`
  - overrides endpoint/api key/table names if needed
- `config :symphony_elixir, :launcher_gateway_config, ...`
  - overrides `gateway_config` / `gateway_config_state` endpoint/api key/table names
- `config :symphony_elixir, :agent_launch_template, %{...}`
  - local-dev fallback config used when no `gateway_config` row matches

## Start semantics

The live `agent` row does not contain a full orchestrator workflow config. Launch
config lives in `gateway_config`, keyed by `(scope_type, scope_id)` with a plain
string `scope_type`. Launcher start resolves the config in this order:

1. `gateway_config` where `scope_type = "agent"` and `scope_id = <agent.id>`
2. `gateway_config` where `scope_type = "workspace"` and `scope_id = <workspace.id>`
3. the launcher-owned base template at `:symphony_elixir, :agent_launch_template`
   (local dev only — skip this fallback in deployed environments)

Stored agent metadata from the `agent` row is then injected under
`config["stored_agent"]` on top of whichever source won resolution.

After a start attempt, the launcher upserts `gateway_config_state` for the winning
scope with:

- `last_applied_hash`, `last_applied_version` — copied from the resolved `gateway_config`
  row (only set on success)
- `last_apply_status` — `"ok"` on success, `"error"` on failure
- `last_apply_error` — set with the failure reason on `"error"`
- `last_apply_at` — timestamp of the apply
- `broker_instance_id` — the launcher-generated orchestrator id, which matches
  `engine_instance.instance_id` (see OR-4)

That means:

- DB owns who the agent is and how the runtime should be configured
- launcher owns how this runtime is started and reports config-sync status back

## Next steps

- Resolve raw secrets from `credential.key_value` only at launch time, not in inventory responses.
- Add workspace/project-aware runtime start routing instead of a single launcher template.
- Persist `agent_id -> running orchestrator` mappings in the API layer if cross-process ownership is needed.
