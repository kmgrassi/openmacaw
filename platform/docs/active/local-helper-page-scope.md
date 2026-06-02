# Local Helper Page Scope (Platform)

## Goal

Replace the current ad-hoc local-runtime setup flow with a single guided
"Local computer" page in `/settings/local-models` that takes a user from
zero to a connected, bound, working local model with **no JSON editing,
no hand-edited config files, and no visible tokens.** The page should be
a linear wizard with four states (Not Registered → Waiting →
Connected → Bound) and surface live presence so the user can see at a
glance whether their helper is reachable.

Production today routes the manager agent's model turns through the
local-relay path when `gateway_config.config_json.runners.manager` has
`provider: "local"`, but the existing UI does **not** write that block —
it only writes `routing_rule_match` rows. That gap means the existing
"assign local model to agent" UI is silently broken for the manager
case. Closing it is the load-bearing backend change in this scope.

**Cross-repo companions:**
- Runtime (relay endpoint, presence heartbeat, helper version validation):
  `parallel-agent-runtime/docs/local-helper-page-runtime-scope.md`
- Helper (`install.sh`, version reporting, token rotation client hook):
  `local-runtime-helper/docs/local-helper-page-helper-scope.md`

## What's already in place (do not re-scope)

| Concern | Where it lives |
| --- | --- |
| `local_runtime_machine` + `local_runtime_token` tables | `parallel-agent-runtime/supabase/generated/types.ts` |
| Platform API for register / list / probe / rotate / delete | `apps/api/src/routes/local-runtime.ts` |
| Settings nav entry "Local Models" + page shell | `apps/web/src/components/settings/LocalModelsSection.tsx` |
| Registration card, registered list, config panel components | `apps/web/src/components/settings/LocalModelRegistrationCard.tsx`, `RegisteredLocalModelsList.tsx`, `LocalRuntimeConfigPanel.tsx` |
| Relay WebSocket endpoint + token validation | `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex` |
| In-process helper registry + presence module | `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/local_relay/{registry,presence}.ex` |
| `local-runtime-helper` Go binary with TOML config + WebSocket register/heartbeat frames | `local-runtime-helper/cmd/local-runtime-helper/`, `internal/config/`, `internal/relay/` |

## Gaps this scope addresses

1. **`assignLocalModelToAgent` doesn't write the manager config.** The
   service at `apps/api/src/services/local-runtime-helpers.ts:6-64` only
   inserts a `routing_rule_match` row. The manager scheduler reads from
   `gateway_config.config_json.runners.manager`, so the manager case
   silently never routes locally even after a successful "assign" call.
2. **No multi-agent attach UI.** Each registered local model can serve
   multiple workspace agents (manager + coding agent + others). Today's
   list view treats assignment as one-shot per row instead of a
   set-of-agents binding.
3. **Presence is in-process only.** `local_runtime_machine.last_seen_at`
   exists in the schema but the runtime relay doesn't write to it on each
   heartbeat, so the platform can't show "online / offline" without a
   cross-service registry query.
4. **Tokens are user-visible and never rotated.** Setup hands the user a
   token string they paste into a TOML file. There is no rotation, no
   automatic renewal, and revocation is manual.
5. **No install one-liner.** Users `go install` the helper or build from
   source. A `curl … | sh` install command rendered by the UI removes a
   whole class of "did you actually install it?" friction.
6. **Helper version isn't reported or surfaced.** The heartbeat frame
   doesn't include a helper version, so the UI can't warn on stale
   versions or know whether a feature is supported.
7. **No status page for the bound state.** Once a helper is connected and
   bound, the user has no view of "which agents are using this, which
   models are advertised, what was the last error."
8. **Delete and re-register don't enforce the one-machine-per-workspace
   promise.** `deleteLocalModelForWorkspace` at
   `apps/api/src/services/local-runtime-machines.ts:445-466` only removes
   `routing_rule_match` + `routing_rule` rows; it never touches
   `local_runtime_machine` or `local_runtime_token`, so the helper can keep
   authenticating after the UI reports it disconnected. Symmetrically,
   `registerLocalModelForWorkspace` scopes "existing machine" by
   `(workspace_id, user_id, display_name)` and never revokes prior
   workspace machines or tokens, so a re-provision leaves stale machines
   and live tokens behind. Both must be fixed before the wizard's
   "Disconnect this machine" and "Set up local computer" buttons can
   honor the locked one-machine-per-workspace decision.

## Design decisions (locked)

- **One machine per workspace.** Schema supports many; the UX shows one.
  Provisioning a new machine implicitly revokes the prior one's active
  token. Multi-machine is a future scope.
- **One manager agent per workspace.** Manager binding is a single
  toggle on the agent list, not a picker.
- **Multiple non-manager agents may attach.** UI is a multi-select
  checklist of workspace agents; each picked agent gets either a
  `routing_rule_match` row (non-manager) or a `routing_rule_match` row
  **plus** a `gateway_config.config_json.runners.manager` upsert
  (manager).
- **Tokens are invisible to the user.** Generated on first setup,
  bundled into the install command output, rotated automatically on a
  schedule (MVP: only rotated on explicit "reset"; auto-rotation comes
  in a later PR). The user never sees the token string in the UI.
- **`install.sh` is hosted at a tagged release in the
  `local-runtime-helper` GitHub repo.** UI renders
  `curl -fsSL https://raw.githubusercontent.com/.../install.sh | sh`
  plus the run command.
- **Presence is passive + active.** Passive: runtime writes
  `local_runtime_machine.last_seen_at` on every heartbeat; UI considers
  "online" if it's within the runtime's own liveness window
  (`heartbeat_interval_ms * 2` — currently 60s, derived from
  `@heartbeat_interval_ms = 30_000` in
  `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex`).
  The threshold is **not** a UI constant — the platform reads the
  interval from `GET /api/local-runtime/models` so it stays aligned
  with the runtime. A tighter threshold would flap on every normal
  heartbeat under jitter. Active: existing
  `POST /api/local-runtime/models/:id/probe` becomes a "Test connection"
  button that does a real round-trip to the model.

## Open questions

1. **Does the production relay enforce token validity today?** The
   `local_relay_require_tls` flag is set in `prod.exs` and
   `TokenValidator.DB` exists, but it should be verified end-to-end
   that an invalid/missing token actually rejects the upgrade. If
   enforcement isn't on, PR1 is also a security hardening change, not
   just UX polish. *Verify before writing the PR plan in detail.*
2. **Token auto-rotation cadence.** 30 days is a reasonable default,
   but rotation requires the helper to atomically rewrite its config
   file with a new token, with a grace window where both old and new
   tokens are valid. Out of scope for the MVP; design pass deferred.
3. **Does the manager scheduler reload `gateway_config` immediately
   after an upsert, or only on a poll interval?** If polling, the UI
   needs to surface "binding will take effect within N seconds" or the
   runtime needs a cache-bust hook. *Verify in
   `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`
   before PR4.*
4. **Should `local_runtime_machine` carry the helper version?**
   Heartbeat-derived columns are write-amplified. Alternative: store
   the latest version in the runtime registry and expose it through a
   `GET /api/local-runtime/models/:id` field that proxies a runtime
   lookup. Lower DB churn, more cross-service plumbing.

## PR plan

### PR1 — Backend writes that make the wizard actually work

Backend-only; unblocks everything else. Three things, all in
`apps/api/src/services/local-runtime-{helpers,machines}.ts`:

**1. Manager-binding dual-write in `assignLocalModelToAgent`.**

- After the existing `routing_rule_match` insert, detect whether
  `agentId` targets the workspace's manager agent.
- If yes, upsert
  `gateway_config.config_json.runners.manager` for the workspace with
  `{ agent_id, provider: "local", model, target_runner_kind, min_cadence_ms }`,
  sourcing `model` and `target_runner_kind` from the resolved
  `routing_rule` row.
- Symmetric removal in `unassignLocalModelFromAgent`: if the agent is
  the manager, also strip `runners.manager` from `gateway_config`.

**2. `deleteLocalModelForWorkspace` actually disconnects.**

- After deleting the `routing_rule_match` and `routing_rule` rows,
  also `update local_runtime_token set revoked_at = now()` for every
  token tied to the machine, and either delete the
  `local_runtime_machine` row or mark it `revoked_at`. (Pick one based
  on whether anything still foreign-keys the row — verify before
  writing the PR.) Without this, the helper continues authenticating
  after the UI reports disconnection.

**3. `registerLocalModelForWorkspace` enforces one machine per
workspace.**

- Before inserting a new machine, revoke every other non-revoked
  `local_runtime_machine` row in the workspace and their tokens. The
  existing `(workspace_id, user_id, display_name)` lookup stays as an
  "is this exactly the same machine being re-registered" idempotency
  check, but any *other* workspace machine is killed.
- This makes the locked design decision ("provisioning a new machine
  implicitly revokes the prior one's active token") true.

**Tests.** Unit tests covering: manager-vs-non-manager assign,
manager-vs-non-manager unassign, delete revokes tokens + machine,
re-register revokes prior workspace machines + tokens. Verify the
exact Supabase write shape per case.

No UI changes in PR1 — after this lands, the existing UI already
starts working for the manager case, and PR4's "Disconnect" and
"Set up local computer" buttons can rely on the backend honoring the
one-machine-per-workspace promise.

### PR2 — `install.sh` + helper version reporting

Helper repo (`local-runtime-helper`).

- Add `install.sh` at repo root that detects platform/arch, downloads
  the matching release binary into `~/.local/bin/local-runtime-helper`,
  and prints next-step instructions.
- Tag the first release that includes the script so the raw GitHub URL
  is stable.
- Add a `Version` field to the `register` and `heartbeat` WebSocket
  frames (sourced from `go build -ldflags "-X main.version=…"`).
- No platform changes yet — runtime PR3 starts consuming the version.

### PR3 — Relay heartbeat writes presence + version

Runtime repo (`parallel-agent-runtime`).

- In `LocalRelaySocket`, on register and every heartbeat, write
  `last_seen_at = now()`, `helper_version = <from frame>`, and
  `advertised_runner_kinds = <from frame>` to the row in
  `local_runtime_machine`.
- Add a `harper-server` migration adding `helper_version text` and
  `advertised_runner_kinds text[]` columns if they don't exist (verify
  current schema first).
- No platform-side changes; presence becomes derivable from a fresh DB
  read.

### PR4 — "Local computer" wizard page (platform UI)

The user-visible change.

- Refactor `LocalModelsSection.tsx` into a state-machine view with
  four states keyed off `(hasMachine, isOnline, hasBoundAgents)`:
  1. **Not registered** — single primary button "Set up local
     computer." On click, mints token + machine row, then renders the
     copy-pasteable `curl … | sh` install command and the
     `local-runtime-helper start --token <token>` run command. Token
     itself is rendered inside the run command (one place, never as a
     standalone field).
  2. **Waiting** — polling indicator. Polls `GET /api/local-runtime/models`
     every 2s and transitions to Connected when `last_seen_at` is
     fresh relative to the runtime's reported `heartbeat_interval_ms`.
  3. **Connected, not bound** — shows helper version, advertised
     runner kinds, advertised models, `runtime_managed_tools` flag,
     last heartbeat. Below that, a multi-select agent list with
     manager flagged separately ("Bind to manager agent" toggle +
     "Also attach to" multi-select). "Save bindings" calls
     `assign`/`unassign` per delta.
  4. **Connected & bound** — green status, summary of bound agents,
     "Test connection" probe button (uses existing `POST /probe`
     endpoint), "Reset token" (revokes + regenerates), "Disconnect
     this machine" (deletes the row + revokes tokens).
- Status dot logic, derived from runtime's `heartbeat_interval_ms`
  (currently 30s, so timeout = 60s): green if `last_seen_at` <
  `interval * 2` (60s), amber `interval * 2`–`interval * 4` (60–120s),
  red beyond. Tooltip shows the timestamp.
- Existing `LocalModelRegistrationCard` / `RegisteredLocalModelsList` /
  `LocalRuntimeConfigPanel` likely fold into states 1, 3, and 4 — do
  not delete; refactor in place.
- Browser smoke (per `CLAUDE.md`): log in with dev credentials, walk
  the wizard, install + run the local helper against the dev runtime,
  verify the page reaches "Connected & bound," send a manager turn,
  confirm it lands locally.

### PR5 — Token auto-rotation (deferred, not in MVP)

Sketch only; do not write this PR until PR1–PR4 ship.

- Runtime issues a rotation hint in the heartbeat ACK frame when a
  token is older than N days.
- Helper receives the hint, exchanges via a new `POST /api/local-runtime/tokens/rotate`
  endpoint, atomically rewrites its config file with the new token.
- Old token stays valid for a 24h grace window; revoked after.
- Schema is already compatible because `local_runtime_token` supports
  multiple non-revoked rows per machine.

## Testing notes

- Each PR carries its own validation per the relevant repo's CLAUDE.md
  (`pnpm -C apps/api run validate`, `pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json`,
  `mix compile --warnings-as-errors && mix test` for the runtime
  changes).
- Manager-binding dual-write (PR1) is the only step that **must** have
  an integration test against a real Supabase instance because the
  failure mode (silently broken manager turns) is undetectable without
  end-to-end coverage.
- After PR4 ships, run the full "Browser Login And Planner Work Item
  Smoke" runbook from the runtime's CLAUDE.md to verify nothing
  regressed in the existing agent-routing path.
