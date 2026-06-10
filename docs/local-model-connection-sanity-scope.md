# Local Model Connection Sanity — Scope

Status: proposed
Owner: TBD
Related: [`orchestrator-intake-flexibility-scope.md`](orchestrator-intake-flexibility-scope.md)

## Problem

Connecting a locally running model (Ollama / LM Studio / any OpenAI-compatible
endpoint) to an agent is one of the project's most important flows, and today
it is hard to complete and nearly impossible to debug. The plumbing works —
helper pairing, WSS relay, dispatch, tool loop — but the system has no
durable, queryable notion of *"this agent runs on this model on this machine,
and here is whether that is working right now."*

Concretely:

- **Binding is split across three UIs that don't know about each other.**
  Helper registration + agent binding live at `/settings/local-runtimes`
  (`platform/apps/web/src/components/settings/LocalRuntimesSection/BindingPanel.tsx`),
  while the agent page has its own model assignment via
  `platform/apps/web/src/components/settings/AgentModelPolicy.tsx` *and* a
  second, newer path in
  `platform/apps/web/src/components/settings/AgentDetail/AgentRuntimeEditor.tsx`.
  Three surfaces write overlapping routing state; which one "wins" is
  ambiguous.
- **`routing_rule` stores `model` + `provider` but no `machine_id`.** The
  orchestrator picks whichever online helper happens to advertise the runner
  kind first
  (`runtime/apps/orchestrator/lib/symphony_elixir/local_relay/registry.ex`).
  No row anywhere says "agent X → machine Y → model Z", so there is nothing
  to inspect when dispatch picks wrong (or picks nothing).
- **Model availability is a registration-time snapshot.** Advertised models
  are captured once when the helper registers. Pulling or removing an Ollama
  model is invisible to the platform until the helper restarts; failures
  surface only at dispatch time as a generic `model_not_found`.
- **No persisted health or error state.** The Elixir relay registry is
  in-memory; the DB has only `last_seen_at`. Every client re-derives
  "online" from timestamp math. When a dispatch fails, the root cause
  (connection refused, 404, context overflow) is normalized away in
  `runtime/apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex` and
  never stored — the UI can only say "something didn't work."
- **Setup is assemble-it-yourself.** The user must discover that *both*
  halves are required: register the helper on one settings page, then
  separately configure the agent's model policy on another. Model names are
  free-text fields rather than the live list the helper could provide.

## Design principles

1. **Persisted truth over inferred truth.** Connection status, advertised
   models, and last failure are rows the UI reads, not heartbeat math every
   client repeats. The orchestrator writes through to the DB on state
   transitions; the in-memory registry remains the dispatch-path source of
   truth for *liveness*, the DB is the source of truth for *history and
   display*.
2. **One binding, one door.** Agent → local model binding is exactly one
   canonical shape (`routing_rule` + `routing_rule_match`, now with
   `machine_id`), written through exactly one API
   (`POST /agents/{agentId}/assign-local-model`). Every UI reads and writes
   through it. No legacy direct-model-field path.
3. **The flow starts at the agent.** The user's intent is "make *this agent*
   use *my* model." The agent page owns the guided flow; the settings page
   becomes the fleet/diagnostics view, not a required setup step.
4. **Errors carry their root cause end to end.** The helper reports what
   actually happened (HTTP status, dial error, timeout); the orchestrator
   persists it; the UI shows it with remediation text. Normalized error
   *codes* stay (retry policy needs them) but never replace the detail.

## Shared contracts (define first — unblocks all workstreams)

These interfaces are the coordination points. Land them in WS0 before the
parallel workstreams start; everything else codes against them.

### Schema additions (Supabase migration)

```sql
-- Live model availability, refreshed on register + heartbeat
create table local_runtime_model (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references local_runtime_machine(id) on delete cascade,
  runner_kind text not null,            -- advertised kind, e.g. openai_compatible
  model text not null,
  provider text,
  capabilities jsonb not null default '{}'::jsonb,
  last_advertised_at timestamptz not null default now(),
  unique (machine_id, runner_kind, model)
);

-- Deterministic binding + persisted failure state
alter table routing_rule
  add column machine_id uuid references local_runtime_machine(id) on delete set null,
  add column last_error text,
  add column last_error_at timestamptz;

-- Persisted connection status (written by orchestrator, read by UI)
alter table local_runtime_machine
  add column status text not null default 'offline'
    check (status in ('online', 'offline', 'degraded'));

-- Connection/dispatch event log (powers the troubleshooting timeline)
create table local_runtime_event (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references local_runtime_machine(id) on delete cascade,
  workspace_id uuid not null,
  kind text not null,                   -- connected | disconnected | heartbeat_timeout
                                        -- | dispatch_failed | model_list_changed | ...
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Pairing tokens expire if never used
alter table local_runtime_token
  add column expires_at timestamptz;
```

### Wire protocol additions (`local-runtime-helper/internal/protocol/protocol.go`)

- `HeartbeatFrame` (helper → cloud) gains an optional `runners` field with
  the same shape as `RegisterFrame.runners` — the helper re-probes its
  endpoints (e.g. Ollama `/api/tags`) and includes the current model list
  every Nth heartbeat (default: every 4th, i.e. ~2 min) and immediately when
  the list changes.
- `ErrorFrame` gains a structured `detail` object:
  `{ http_status?, dial_error?, endpoint?, raw_message? }` alongside the
  existing `code` / `message` / `retryable`.
- `CancelAckFrame` (helper → cloud, new): `{ correlation_id, outcome }` so
  the cloud knows a cancel landed.

### API surface (platform)

- `POST /agents/{agentId}/assign-local-model` — **the only write path** for
  agent → local binding. Request gains `machineId`; creates/updates the
  `routing_rule` with `machine_id` set.
- `GET /local-runtimes` — response gains per-machine `status`, per-runner
  live `models` (from `local_runtime_model`), and `lastError`.
- `GET /local-runtimes/{machineId}/events?limit=50` — recent
  `local_runtime_event` rows (new).
- `POST /local-runtimes/{machineId}/test-dispatch` — fires one minimal
  real dispatch through the full path and returns per-hop results:
  `{ helperConnected, modelAdvertised, dispatchSucceeded, error? }` (new).

## Scope

### WS0 — Schema + contracts (foundation; serial, small, land first)

One PR. Everything above under "Shared contracts": the Supabase migration,
Zod schema updates in `platform/contracts/local-runtime.ts`, protocol struct
additions in Go (fields only — no behavior), and the matching Elixir frame
parsing (accept-and-ignore). All additions are backward compatible: old
helpers that never send `runners` in heartbeats or `detail` in errors keep
working.

*Acceptance:* migration applies cleanly; existing register/dispatch flows
pass unchanged; contracts package exports the new types.

### WS1 — Runtime write-through + deterministic lookup (Elixir)

Depends on WS0. Parallel with WS2–WS5.

- On register/evict/heartbeat-timeout in `local_relay_socket.ex` and
  `registry.ex`: write `local_runtime_machine.status`, append a
  `local_runtime_event`, and upsert `local_runtime_model` rows from the
  advertised runner list (register and model-bearing heartbeats).
- Lookup in `registry.ex` becomes: prefer the helper whose `machine_id`
  matches the routing rule's; fall back to any online helper advertising the
  runner kind (preserves today's behavior for machine-less rules).
- On dispatch failure in `runner/local_relay.ex`: persist `last_error` /
  `last_error_at` on the routing rule and append a `dispatch_failed` event
  with the full `ErrorFrame.detail`.
- Handle `CancelAckFrame` (log + event; no retry semantics change).

*Acceptance:* kill the helper mid-session → machine row flips to `offline`
within one heartbeat timeout and an event row exists; a dispatch to a
stopped Ollama leaves a `last_error` containing the dial error; two machines
advertising the same model + a rule pinned to machine B always dispatches
to B.

### WS2 — Helper: live models + rich errors (Go)

Depends on WS0. Parallel with WS1, WS3–WS5. No dependency on WS1 — the
orchestrator accepts-and-ignores until WS1 lands.

- Periodic endpoint re-probe (Ollama `/api/tags` or `/v1/models`) in the
  `openai_compatible` runner; include the current model list in heartbeats
  per the protocol contract; send immediately on change.
- Populate `ErrorFrame.detail` with the underlying HTTP status / dial error
  / timeout cause at every error site in
  `internal/runner/openai_compatible/openai_compatible.go` and
  `internal/relay/relay.go`.
- Ack `cancel` frames with `CancelAckFrame`.
- `local-runtime-helper doctor` gains a `--json` output mode (consumed by
  nothing yet; WS4's doctor panel mirrors its checks server-side, and the
  JSON mode keeps CLI/UI check parity testable).

*Acceptance:* `ollama pull` of a new model shows up in a heartbeat within
~2 min without restarting the helper; stopping Ollama mid-dispatch produces
an `ErrorFrame` whose detail names the connection error and port.

### WS3 — Platform API: one door for binding + read APIs (TypeScript)

Depends on WS0. Parallel with WS1, WS2. WS4/WS5 consume its endpoints
(mockable from the WS0 contracts, so UI work can start immediately).

- `assign-local-model` accepts and persists `machineId`; it becomes the only
  write path for local bindings. Audit and remove direct routing-rule writes
  from `local-runtime-machines.ts` registration (registration still creates
  the machine + token, but agent bindings only via the one endpoint) and any
  legacy direct-model-field path the web app still hits.
- Implement the new read endpoints: enriched `GET /local-runtimes`,
  `GET /local-runtimes/{machineId}/events`, and
  `POST /local-runtimes/{machineId}/test-dispatch` (drives a minimal
  dispatch via the orchestrator and reports per-hop results).
- Pairing-token expiry: set `expires_at` (default 24 h) at creation; reject
  expired-unused tokens at validation; surface "token expired — reset to get
  a new one" distinctly from "token invalid".

*Acceptance:* binding an agent from any UI results in exactly one
routing_rule with `machine_id` set; `GET /local-runtimes` reflects a model
pulled into Ollama within ~2 min (with WS1+WS2 deployed); test-dispatch
returns hop-by-hop results for both the success and each failure mode.

### WS4 — Web UI: status chip + doctor panel (TypeScript/React)

Depends on WS3's read endpoints (developable against WS0 contract mocks).
Parallel with WS5.

- **Status chip** wherever an agent with a local binding appears (agent
  list, agent detail): `🟢 qwen2.5-coder @ kevins-macbook` /
  `🔴 offline — last seen 3 h ago` /
  `🟡 model no longer advertised by helper`. Data comes from the enriched
  list endpoint — no client-side heartbeat math. Clicking opens the event
  timeline.
- **Doctor panel** on `/settings/local-runtimes`: checklist mirroring the
  CLI doctor's checks (helper connected → runner advertised → model present
  → test dispatch), each row with pass/fail and remediation text ("helper
  hasn't connected: is the daemon running?", "model missing:
  `ollama pull …`"). "Run test" drives `test-dispatch`.
- Replace generic failure copy with persisted `last_error` detail throughout
  `LocalRuntimesSection` and the agent model UIs.

*Acceptance:* with the helper stopped, the agent page says so without
visiting settings; every distinct backend failure mode renders distinct
copy with a remediation hint.

### WS5 — Web UI: unified "Use a local model" wizard (TypeScript/React)

Depends on WS3 (binding + test-dispatch endpoints) and shares components
with WS4 (status logic, doctor checks). Largest UX item; intentionally last.

- Entry point on the agent page: a single drawer that walks through
  ① helper status (if unregistered: show install command inline with the
  existing 2 s "waiting for connection" polling), ② pick a model from the
  *live* advertised list (dropdown fed by `local_runtime_model` — no
  free-text model names), ③ run test-dispatch with per-hop results,
  ④ bind via the one API.
- Consolidate the three binding surfaces: the wizard + a compact read view
  replace `AgentModelPolicy`'s local panels and `AgentRuntimeEditor`'s local
  branch; `BindingPanel` on the settings page becomes read-only fleet view
  ("which agents use this machine") linking back to each agent's wizard.
  Delete the superseded write paths — one canonical UI shape, not two kept
  in sync (see design principle 2).

*Acceptance:* a user with a running Ollama and no prior setup can go from
the agent page to a working, tested local binding without visiting
`/settings/local-runtimes` or typing a model name; no remaining UI writes
local bindings except through `assign-local-model`.

## Parallelization summary

```
WS0 (schema + contracts) ─┬─→ WS1 (Elixir write-through)   ─┐
  one PR, land first      ├─→ WS2 (Go helper)               ├─→ integration
                          ├─→ WS3 (platform API) ─┬─→ WS4 ──┤   testing
                          │     (UI can mock WS0  └─→ WS5 ──┘
                          │      contracts day 1)
```

- WS1, WS2, WS3 are fully independent of each other (the wire protocol and
  schema they share are frozen in WS0; each side accepts-and-ignores until
  its counterpart lands).
- WS4 and WS5 can start against mocked WS3 responses generated from the WS0
  Zod schemas.
- Suggested staffing: 1 person × ~1 day on WS0, then up to 5 parallel
  tracks. WS1+WS2 pair well under one owner (they meet at the wire
  protocol); WS4+WS5 pair well under one owner (shared components).

## Out of scope

- Auto-discovery / zero-config pairing of the helper (mDNS, magic links) —
  the install-command flow stays; we make it observable, not invisible.
- Multi-machine load balancing or failover policy beyond "prefer the pinned
  machine, fall back to any online" — revisit once bindings are
  deterministic.
- Changes to the cloud-managed vs helper-managed tool-loop split.
- Hosted-provider credential management UX (`/settings/models`).
- Heartbeat/backoff interval tuning per workspace.
