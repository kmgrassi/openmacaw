# `/local-chat` Deprecation & Coding-Agent Relay Routing Scope (Platform)

## Goal

Phase out Platform's `POST /api/agents/:agentId/local-chat` direct-to-helper
HTTP shortcut and route coding-agent local-model traffic through Runtime's
relay path instead. Today `/local-chat` is the de-facto production path for
local coding even though `apps/api/src/routes/local-model-proxy.ts:372`
explicitly comments "DEV ONLY". The architectural target makes Runtime the
canonical orchestrator for *all* local model traffic — Platform should never
talk directly to the helper for production agent work.

**Cross-repo companions:**
- Runtime (canonical wire contract): `parallel-agent-runtime/docs/local-coding-relay-unification-scope.md`
- Helper (parity adoption): `local-runtime-helper/docs/relay-contract-parity-scope.md`

## What's already scoped (do not re-scope)

| Concern | Owner doc |
| --- | --- |
| Local model coding runner & tool surface | `docs/shipped/local-model-coding-runner-scope.md` (already shipped) |
| Local model readiness — provider selection UI | `docs/shipped/local-model-readiness-platform-prs.md` (already shipped) |
| Universal tool calling shape | `docs/shipped/universal-tool-calling-plan.md` (superseded but historical) |
| Tool grant data model | `docs/active/agent-tool-grant-data-model-scope.md` |
| Production container execution (cloud sandbox) | `docs/active/production-container-tool-execution-scope.md` |

## Gaps this scope addresses

1. **No deprecation plan for `/local-chat` exists.** Existing scoping
   describes both `/local-chat` and the relay path as coexisting options; no
   doc says which one production should converge on, when, or how.
2. **Coding-agent dispatch routing is split.** Some code paths assume
   `/local-chat` (`local-model-proxy.ts`); Runtime-routed dispatch exists for
   other agent types but coding agents are not consistently routed through
   it.
3. **Web client calls `/local-chat` directly.** Migrating Runtime-side first
   without updating the client leaves coding agents broken; both must move
   together.
4. **No migration safety net.** Once `/local-chat` is gated, any agent still
   configured against it silently breaks. There's no audit/migration script.

## PR plan

### PR1 — Mark `/local-chat` dev-only at runtime

- Add a `DEV_LOCAL_CHAT_ENABLED` env flag (default `false` outside
  `NODE_ENV=development`).
- In `local-model-proxy.ts`, return 410 Gone with a clear message when the
  flag is off. Existing dev workflows set the flag explicitly.
- Add a one-line warn log on every `/local-chat` request so any production
  caller is visible in logs.
- Update `apps/web/.env.example` and the local-dev runbook to set the flag.
- No agent dispatch logic changes yet.

### PR2 — Route coding agents through Runtime relay

- In the dispatch service (the layer that turns an agent message into a
  worker bridge call), detect `runner_kind === "local_model_coding"` and
  send through the Runtime relay path *only*. Today this branch may fall
  through to `/local-chat`-style handling for some inputs; this PR makes the
  Runtime path mandatory for coding agents.
- Depends on Runtime PR1 (canonical `schema_version`) being merged so the
  wire format is settled.
- Tests: existing dispatch tests should pass; add one asserting a coding
  agent dispatch never produces a `/local-chat` HTTP call.

### PR3 — Migrate the web client

- `apps/web` — find all `fetch("/api/agents/:id/local-chat", ...)` callers.
  Identify which are coding-agent surfaces (production) vs dev model-check
  surfaces.
- Coding-agent surfaces switch to the Runtime-routed message endpoint
  (whatever the canonical path is — likely `/api/agents/:id/messages` going
  through worker bridge).
- The model-check / dev-tools surface keeps `/local-chat` calls but only
  works when `DEV_LOCAL_CHAT_ENABLED` is set.
- Browser smoke: log in, open a coding agent, send a message that triggers
  apply_patch, verify result via Runtime path.

### PR4 — Migration audit

- One-off script under `scripts/`: list any agents (`runner_kind`,
  `execution_target`, etc.) still configured to dispatch via `/local-chat`
  for non-dev workflows.
- Operator-run; produces a CSV of agent IDs and current routing.
- Pair with a doc note on how to migrate each (usually flipping a runner_kind
  or execution_target).

### PR5 — Remove the dev bridge

After Runtime PR5 (full coding-agent smoke test) lands and PR2/PR3 have run
in production for a deprecation window:

- Delete `local-model-proxy.ts` and the `/api/agents/:id/local-chat` route.
- Delete `services/local-chat-agent-tools.ts` and its test (functionality
  moved into Runtime).
- Update web to remove the dev-mode model-check surface, OR move it to a
  clearly dev-only URL like `/dev/local-chat-probe`.
- Drop the `DEV_LOCAL_CHAT_ENABLED` flag.

## Sequencing & cross-repo dependencies

```
Runtime PR1+PR2 (wire contract canonical)
       │
       ├──► Platform PR1 (mark dev-only — no wire dep, can land first)
       ├──► Platform PR2 (route coding agents through Runtime relay)
       │       │
       │       └──► Platform PR3 (web client migration)
       │
       └──► Platform PR4 (audit — independent, can land any time)

Runtime PR5 (smoke test) + Platform PR2+PR3 in prod for deprecation window
       │
       └──► Platform PR5 (delete `/local-chat`)
```

PR1 is fully independent and can land immediately. PR2/PR3 wait on Runtime
PR1. PR5 is the last step and gates on Runtime PR5 + a soak window.

## Out of scope

- Replacing `/local-chat` for non-coding agent types (planner, manager) —
  separate scopes already exist for those local-model paths.
- Cloud sandbox tool execution (`production-container-tool-execution-scope.md`).
- Tool-grant resolution changes (`agent-tool-grant-data-model-scope.md`).
- Runtime relay infra changes — owned by the runtime companion doc.
