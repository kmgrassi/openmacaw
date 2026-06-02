# Local Helper Page — Runtime Scope

## Goal

Runtime-side companion to the platform's "Local computer" wizard scope.
This doc owns the relay heartbeat changes that let the platform UI show
live presence ("is this helper online right now?") and surface helper
metadata (advertised runners, capabilities, helper version) without a
cross-service registry query.

The wizard UX rests on three runtime contracts:

1. The relay heartbeat **writes** to `local_runtime_machine` on every
   register/heartbeat so `last_seen_at` is fresh enough to drive a
   passive presence indicator (`< 30s` = online).
2. The heartbeat frame carries a `helper_version` and the registry
   already-surfaced `advertised_runner_kinds` are persisted so the
   platform can show them and warn on stale versions.
3. The manager scheduler picks up changes to
   `gateway_config.config_json.runners.manager` quickly enough that the
   wizard's "Bind to manager agent" action visibly takes effect.

**Cross-repo companions:**
- Platform (wizard UI + manager dual-write): `parallel-agent-platform/docs/active/local-helper-page-scope.md`
- Helper (`install.sh`, version field in heartbeat): `local-runtime-helper/docs/local-helper-page-helper-scope.md`

## What's already in place (do not re-scope)

| Concern | Where it lives |
| --- | --- |
| WebSocket relay endpoint `/local-relay/ws` with register/heartbeat frames | `apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex` |
| In-process helper registry (workspace_id, runner_kind → pid) | `apps/orchestrator/lib/symphony_elixir/local_relay/registry.ex` |
| Presence tracker (in-memory `{workspace_id, machine_id}` keyed) | `apps/orchestrator/lib/symphony_elixir/local_relay/presence.ex` |
| Token validation (`TokenValidator.DB` in prod, config tokens in dev) | Various callers; configured per env |
| TLS enforcement in prod (`local_relay_require_tls: true`) | `apps/orchestrator/config/prod.exs` |
| `local_runtime_machine` table schema (`last_seen_at`, `display_name`, `workspace_id`, `revoked_at`) | `supabase/generated/types.ts` |
| `local_runtime_token` table with hash + revoked_at | `supabase/generated/types.ts` |

## Gaps this scope addresses

1. **Presence is in-memory only.** The presence module tracks online
   helpers in Elixir state but never writes to
   `local_runtime_machine.last_seen_at`. The platform cannot derive
   "online / offline" from a DB read.
2. **No helper-version column.** The heartbeat frame doesn't carry a
   version yet (helper-side change), and there's no column to land it
   in. The platform can't warn on stale helpers without this.
3. **Advertised runner kinds aren't persisted.** The registry knows
   what each helper advertises in-process, but the platform can only
   read them by reaching into the orchestrator. A
   `advertised_runner_kinds text[]` column on `local_runtime_machine`
   lets the platform render this from a normal Supabase query.
4. **Token enforcement parity needs explicit verification.** The
   wizard makes tokens invisible to the user, which is only safe if
   the relay actually rejects bad/missing tokens in prod. We believe
   this is on (`TokenValidator.DB` + TLS), but no test or doc captures
   it end-to-end.
5. **Manager `gateway_config` reload cadence is undocumented.** Once
   the platform upserts
   `gateway_config.config_json.runners.manager`, how long until the
   scheduler picks it up? If it's a long poll, the wizard needs a
   user-facing "binding will activate within N seconds" caveat or
   the scheduler needs a cache-bust hook.

## Design decisions (proposed; review before PR work)

- **Write-through, not write-around.** The relay socket writes
  `last_seen_at`, `helper_version`, and `advertised_runner_kinds`
  directly to the row on each heartbeat. No new in-memory cache; the
  registry stays the source of truth for routing but the DB row
  becomes the source of truth for observability.
- **Heartbeat write cadence matches frame cadence.** The runtime's
  `@heartbeat_interval_ms = 30_000` in
  `apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex:14`
  is the contract; the helper is supposed to match it (advertised in
  the register-ack). Each heartbeat writes the row. If write
  amplification is a concern later, batch or throttle in a follow-up.
- **Presence threshold derives from the runtime contract, not a
  hand-picked UI constant.** The runtime considers a helper dead
  after two intervals (`heartbeat_timeout_ms = @heartbeat_interval_ms
  * 2 = 60_000`). The platform UI's "online" threshold should be
  **`< heartbeat_interval_ms * 2`** = 60s, matching the runtime's own
  liveness check. A tighter threshold (e.g. 30s) would flap on every
  normal heartbeat under any jitter. Expose `heartbeat_interval_ms`
  in `GET /api/local-runtime/models` so the platform derives the
  threshold rather than hardcoding 60s.
- **`helper_version` is a free-form string, not enum.** SemVer is the
  expected shape but the column is text; runtime doesn't gate behavior
  on it, only the platform UI does.
- **`advertised_runner_kinds` is the authoritative list, not the
  registry.** When the registry deregisters a helper, the column is
  cleared (or set to `{}`). When a new helper registers, the column
  is replaced — not appended to — to avoid stale entries from a
  previous machine.

## Open questions

1. **Is token enforcement actually live in prod?** Walk through
   `TokenValidator.DB.validate/1` and confirm: (a) a request with no
   token is rejected on upgrade, (b) a revoked token is rejected, (c)
   a TLS-less request to a prod-configured runtime is rejected. If
   any of these don't reject, the wizard's "invisible tokens" promise
   is undermined — add explicit tests before platform PR1 ships.
2. **Scheduler reload cadence.** Inspect
   `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex` —
   does it re-fetch `gateway_config` on every tick, or cache between
   ticks? If cached, what invalidates it? This determines the wizard
   UX answer.
3. **~~Heartbeat cadence~~** ✅ Answered: runtime sets
   `@heartbeat_interval_ms = 30_000` with a 2-interval timeout (60s).
   Platform's threshold has been updated to 60s. Helper doc tracks
   matching the contract.
4. **Migration ownership.** The new `helper_version` and
   `advertised_runner_kinds` columns are DB changes; per the runtime
   CLAUDE.md, migrations live in `harper-server`. Confirm the
   migration is authored there, not here.

## PR plan

### PR1 — Verify and document production token enforcement

Read-only PR, no code changes if everything's already wired correctly.

- Trace each rejection path in
  `apps/orchestrator/lib/symphony_elixir_web/local_relay_socket.ex`
  and the resolved `TokenValidator.DB`. Document the exact paths.
- Add (or expand) an integration test that asserts: missing token →
  reject, malformed token → reject, revoked token → reject, expired
  TLS-less request in prod config → reject.
- If any gap is found, add the rejection and the test in this PR.
- Update this scope doc's Open Question #1 with the verified answer.

### PR2 — Schema migration in `harper-server`

Not a runtime PR; tracked here because it gates PR3.

- Migration adds to `local_runtime_machine`:
  - `helper_version text` (nullable)
  - `advertised_runner_kinds text[]` (nullable, default `{}`)
- After the migration ships and the platform regenerates types, this
  repo runs `pnpm run supabase:schema:sync` to refresh
  `supabase/generated/postgrest-schema.json` and the Elixir bridge
  file.

### PR3 — Relay heartbeat writes presence + version + runners

The load-bearing runtime change.

- In `LocalRelaySocket`, in the register-frame handler:
  - Validate `helper_version` and `runner_kinds` fields (helper PR2
    adds these). Reject the connection with a typed error if
    `helper_version` is missing once helper PR2 ships and a minimum
    version is enforced.
  - Write `last_seen_at = now()`, `helper_version`,
    `advertised_runner_kinds` to the matching `local_runtime_machine`
    row.
- In the heartbeat handler, write the same three columns on each
  frame.
- On socket close / deregister, write `last_seen_at` one last time
  and clear `advertised_runner_kinds` (so a stale machine row never
  claims to advertise something).
- Tests: extend the existing `local_relay_socket_test.exs` (or
  equivalent) with assertions that the row is updated after each
  frame.
- Validation per runtime CLAUDE.md: `mix compile --warnings-as-errors`
  and `mix test`.

### PR4 — Document or fix the scheduler reload cadence

Depends on Open Question #2 outcome.

- If the scheduler already re-reads `gateway_config` on every tick:
  document that in `apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex`
  as a comment and update the platform doc to drop the caveat.
- If it caches: add a `Manager.WorkspaceEvents` invalidation hook so
  an `:manager_workspace_updated` message bumps the cached config.
  Platform's `assignLocalModelToAgent` then publishes that event after
  its dual-write. Latency drops to a single PubSub round-trip.

## Testing notes

- PR1 carries integration tests against a real (or test-config) relay
  endpoint with valid/invalid tokens. Per CLAUDE.md, validation =
  `mix compile --warnings-as-errors` + `mix test`.
- PR3's heartbeat write is hot-path code; pay attention to error
  handling (a DB write failure must not tear down the WebSocket
  connection — log it, keep the socket alive, and move on).
- After PR3 ships and platform PR4 lands, run the full `Browser Login
  And Planner Work Item Smoke` runbook to verify nothing regressed in
  agent routing.
