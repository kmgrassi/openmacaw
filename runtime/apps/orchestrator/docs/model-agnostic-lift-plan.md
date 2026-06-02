# Lift Plan: From OpenAI/Codex-Specific Runtime to Model-Agnostic Orchestration

This plan turns the current implementation into a provider-agnostic execution platform while keeping orchestration stable.

It should be read together with `backend-adapter-contract.md`, which defines
the recommended backend adapter contract, normalized event model, and worker
target/capability shape for this repo.

## Pure-Orchestrator Boundary (recommended baseline)

Keep the repository’s orchestration logic provider-agnostic and stateful, and move execution/coordination into external workers.

```mermaid
flowchart LR
  subgraph Control Plane (inside this repo)
    A[Workflow Loader + Config] --> B[Orchestrator]
    B --> C[Workspace Metadata Store]
    B --> D[Tracker Adapter]
    B --> E[Runner Adapter + Provider Router]
    F[Health/Status API] --> C
  end

  subgraph Persistence
    C[(Database)]
  end

  subgraph Execution Plane (external repos/services)
    E --> G1[Codex Worker Service]
    E --> G2[OpenClaw Worker Service]
    E --> G3[Other Providers]
    G1 --> H[Issue Workspace/Repo]
    G2 --> H
    G3 --> H
  end

  B --> C
  G1 --> C
  G2 --> C
  G3 --> C

  B -->|callbacks/events| C
  C -->|read state| F
  Client[Operator UI / Automation API] -->|query + commands| C
```

### Hard boundary contract

- Orchestrator owns:
  - issue claim/retry/release lifecycle
  - provider routing policy
  - run attempts and terminal-state reconciliation
  - validation and backoff behavior
- Orchestrator persistence owns:
  - issue ownership
  - workspace references (local path or remote workspace URI)
  - provider assignment, session/run ids, attempt count, state, timestamps
  - heartbeats/lease, cancellation, completion/error summaries
- Execution services own:
  - protocol session handling
  - workspace bootstrap and tool execution
  - model/provider-specific auth and command semantics
  - emitted run outcomes mapped to orchestrator event schema

### Persistence mapping in the current schema

The repository already has strong equivalents for most of the persistence shape
needed for the backend-adapter architecture. The rollout should reuse these
tables instead of introducing redundant greenfield tables unless a real gap
remains after adapter work starts landing.

Current equivalents:

1. `broker_run`
   - closest equivalent to the proposed `issue_runs`
   - already stores:
     - `run_id`
     - `agent_id`
     - `workspace_id`
     - `attempt`
     - `status`
     - `queued_at`
     - `started_at`
     - `completed_at`
     - `terminal_reason`
     - `error`
     - `issue_identifier`
     - tracker metadata
     - input/output payload JSON
     - `session_thread_id`
     - `workspace_path`
   - likely extension points:
     - backend identifier if `mode`/`metadata` is not sufficient
     - explicit worker target / host reference if not kept in `metadata`

2. `broker_task`
   - partially covers execution-task state that the earlier draft described as
     part of `issue_runs` or `sessions`
   - already stores:
     - `task_id`
     - `run_id`
     - `attempt`
     - `status`
     - `lease_expires_at`
     - token counts
     - last event summary fields
     - current Codex-specific thread/session identifiers
   - likely extension points:
     - generalized backend-specific task metadata
     - replacing Codex-only keys with backend-neutral fields or moving them into JSON metadata

3. `session_thread`
   - closest equivalent to the proposed `sessions`
   - already stores:
     - `agent_id`
     - `workspace_id`
     - `session_key`
     - `status`
     - model/provider information
     - usage counters
     - session metadata and origin
     - reset and compaction timestamps
   - likely extension points:
     - backend target identity
     - provider session identifiers when needed
     - backend capability or transport metadata if not derived elsewhere

4. `message`
   - already stores durable message-level artifacts tied to:
     - `run_id`
     - `session_id`
     - `thread_id`
     - `provider`
     - `payload`
     - `metadata`
   - this is useful for persisted turn output and auditability, but it is not
     yet a generic normalized backend event stream

5. `openclaw_agent_session_index`
   - already covers one important OpenClaw-specific need:
     - agent/session reuse mapping by `agent_id`, `workspace_id`, and `session_key`
   - this means the first OpenClaw backend work should reuse this table instead
     of inventing a second remote-session index

### Remaining likely schema gap

The biggest remaining persistence gap is not “runs” or “sessions” as tables,
because those largely exist already. The likely gap is a generic normalized
backend event history if we decide that:

- `broker_task.last_event` is too shallow
- `message` is too message-centric
- backend telemetry must be replayed or audited independently of chat output

That gap should be validated during the normalized-event refactor before adding
a new table.

### Why this is a cleaner split

1. Orchestrator can stay pure and deterministic.
2. Multiple orchestrator instances can run safely using DB locks/leases that
   already exist in the current persistence shape.
3. New providers are adapters, not rewrites.
4. API/UI becomes a consumer of persisted state instead of owning scheduling logic.
5. Recovery after crashes becomes explicit and auditable.

## Target state

- Orchestration remains unchanged as a service loop: poll → reconcile → claim → dispatch → run → retry.
- The provider-specific runtime is isolated behind a backend adapter abstraction.
- A default Codex runner remains the default, so existing behavior is preserved.
- Additional providers (OpenClaw and others) can be introduced without redesigning tracker, workspace, or retry logic.

## Direct answer: can the orchestration be a different model?

Yes, orchestration is model-agnostic by design and can stay unchanged. The lift is to move model/provider
coupling out of `agent_runner` into an adapter layer with a narrow backend contract:

- validate target
- start run
- stream normalized events
- cancel/interrupt where supported
- ping/health for backend availability checks

Then orchestration chooses a provider for each issue (or per default) without changing state transitions,
retry rules, or workspace management.
## Assumptions

- You want to preserve current issue lifecycle semantics: claims, retries, continuation turns, terminal cleanup, and state reconciliation.
- You do not need orchestrator-managed write APIs in this phase.
- You can accept an additive rollout with two migration stages: `runner abstraction` first, `new provider` second.

---

## Phase 0 — Discovery and contract freeze (2–3 days)

### Outcomes
- Lock down cross-provider event/error schema.
- Define which `WORKFLOW.md` keys are extension-only vs required.
- Agree rollback strategy: start/stop with no behavior change for Codex-only runs.

### Concrete work

1. Capture provider-agnostic event contract:
   - `run.started`, `message.delta`, `message.completed`, `tool.started`, `tool.completed`, `status`, `warning`, `error`, `run.completed`, `run.failed`, `run.cancelled`.
2. Decide backend capability metadata:
   - supported tools
   - sandbox/approval model
   - streaming format
   - interrupt support
   - agent/session/config ops
3. Document mapping table:
   - “Codex event” → “internal normalized event”.
4. Add migration policy doc:
   - feature flag + default provider fallback.

### Files (new/changed)
- New:
  - `elixir/docs/model-agnostic-lift-plan.md` (this file)
  - `elixir/docs/model-provider-capability-matrix.md` (next phase)
- Update:
  - `elixir/docs/implementation_docs_index.md`

---

## Phase 1 — Runner boundary extraction (2–4 weeks)

This is the minimum viable lift. This phase alone enables future providers.

### Scope

Introduce a formal backend interface and decouple orchestrator from Codex internals.

### Deliverables

1. Add `SymphonyElixir.Runner` behavior shaped around backend execution, not subprocess assumptions.
2. Move app-server protocol and session state to `SymphonyElixir.Runner.Codex` as the `stdio` backend.
3. Change orchestration calls to resolve backend target + delegate runner actions.
4. Keep normalization events stable for existing dashboard/API.
5. Ensure current Codex behavior is the default fallback.

### Files to touch

- `elixir/lib/symphony_elixir/agent_runner.ex`
  - currently invokes Codex app-server directly.
- `elixir/lib/symphony_elixir/codex/app_server.ex`
  - move behind behavior adapter, keep implementation.
- `elixir/lib/symphony_elixir/codex/dynamic_tool.ex`
  - keep as Codex-specific tool layer.
- `elixir/lib/symphony_elixir/config/schema.ex`
  - add runner/provider config fields in extension-safe way.
- `elixir/lib/symphony_elixir/config.ex`
- backend target resolution helpers for runtime.
- `elixir/lib/symphony_elixir/workflow.ex` (if schema docs are generated from workflow)
- `elixir/lib/symphony_elixir/orchestrator.ex`
  - replace direct runner assumptions with runner contract call sites.

### Acceptance criteria

- Existing local and SSH workflows run unchanged.
- No API contract breakage for `/api/v1/*`.
- Retry logic still drives by session outcomes.
- 1:1 run behavior for current Codex workloads.

### Risk controls

- Feature flag: default backend remains current Codex/stdio path.
- If runner init fails: retain previous path as fallback for a grace window.
- Add dual write to logs: provider name + normalized event.

---

## Phase 2 — OpenClaw provider adapter + provider-aware routing (3–6 weeks)

### Scope

Add second execution family (OpenClaw) and route selected work to it through
explicit backend adapters.

### Deliverables

1. Add `SymphonyElixir.Runner.OpenClawWS`.
2. Add `SymphonyElixir.Runner.OpenClawSSE`.
3. Add backend target config model in WORKFLOW:
   - URL, auth env, model/default, request timeout, capability flags, session strategy.
4. Add routing strategy:
   - static backend target assignment
   - issue-label-based overrides
   - fallback to default target.
5. Add backend health/ping integration.
6. Add adapter-specific completion mapping:
   - maps transport-specific OpenClaw responses to normalized backend events.

### Files to touch

- New:
  - `elixir/lib/symphony_elixir/runner/openclaw_ws.ex`
  - `elixir/lib/symphony_elixir/runner/openclaw_sse.ex`
  - `elixir/lib/symphony_elixir/runner/selection.ex` (or equivalent strategy module)
- Update:
  - `elixir/lib/symphony_elixir/agent_runner.ex`
  - `elixir/lib/symphony_elixir/config/schema.ex`
  - `elixir/docs/model-provider-swap.md` (replace prototype with finalized provider config)
- Tests:
  - add adapter contract tests and provider routing tests.

### Acceptance criteria

- Workflow can run with an OpenClaw backend target without changing orchestrator runtime.
- OpenClaw failures map to existing retry buckets (transient/fatal/slot constraints).
- One issue can be rerouted by label/priority policy.

---

## Phase 3 — Normalized event and tool contract hardening (2–4 weeks)

### Scope

Guarantee orchestration logic does not drift per backend.

### Deliverables

1. Backend-neutral `AgentEvent` struct/schema.
2. Normalize:
   - usage/rate-limit payloads,
   - approval/blocked-input events,
   - tool call failure semantics.
3. Introduce clear `hard_fail`, `retryable_fail`, `input_required`, `tool_unsupported` classes.
4. Ensure API surfaces and dashboard read from normalized event stream only.

### Acceptance criteria

- Core orchestration logic uses normalized fields only.
- No transport-specific branching in orchestrator state transitions.
- Existing Codex metrics remain numerically stable after normalization.

---

## Phase 4 — Remote worker topology + frontend contract alignment (2–3 weeks)

### Scope

Make remote worker usage provider-aware and expose stable frontend APIs.

### Deliverables

1. Introduce worker type metadata in state snapshots:
   - provider, worker_host/worker_host_url, ping state.
2. Extend ping lifecycle and skip failed workers during dispatch.
3. Add dedicated issue detail field for provider origin + adapter telemetry.
4. Align JSON contract for React dashboard and SSE/WebSocket extension.

### Files to touch

- `elixir/lib/symphony_elixir/orchestrator.ex`
- `elixir/lib/symphony_elixir/workspace.ex`
- `elixir/lib/symphony_elixir_web/presenter.ex`
- `elixir/lib/symphony_elixir_web/controllers/observability_api_controller.ex`
- `elixir/lib/symphony_elixir/status_dashboard.ex` (optional)

---

## Phase 5 — Security and deployment packaging (1–2 weeks)

### Scope

Model-agnostic runtime should be deployment-safe.

### Deliverables

- provider credential scoping by role/mode
- explicit worker command/tool allowlist and approval policy per provider
- update `elixir/deploy/aws.json` to include:
  - provider secrets, model IDs, provider routes, health endpoints
- docs for secure fallback policy and rollback.

### Acceptance criteria

- Same binary image can run with one or multiple providers through config alone.
- No code changes required to switch from Codex default to OpenClaw in non-prod once wired.

---

## Suggested timeline (realistic)

- **MVP path (Codex decoupled + one extra provider):** 6–10 weeks
- **Staged rollout with remote workers and frontend contract hardening:** 9–14 weeks

---

## Who owns what

- Platform/Infra: deployment + secrets + network + worker connectivity.
- Runtime: runner abstraction + orchestrator decoupling.
- Provider Adapters: Codex extraction + OpenClaw adapter.
- Product/Observability: API contract and dashboard updates.

---

## Non-goals for this lift

- Full tracker write support in orchestrator (kept in agents by workflow/tooling).
- Full re-architecture of scheduler internals (intentionally preserved).
- Immediate migration of all existing external integrations.

---

## Exit criteria (go/no-go)

- All tests in `core` + new adapter tests pass.
- 2 provider profiles validated in staging with replayed and live smoke issues.
- Rollback tested by switching `agent.default_provider` from new provider back to `codex`.
- No regression in continuation/slot/retry semantics for existing Codex flows.
