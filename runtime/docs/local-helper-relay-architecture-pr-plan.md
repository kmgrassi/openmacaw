# Local Helper Relay Architecture - Remaining Runtime PR Plan

Repo: `parallel-agent-runtime`.

This plan only covers work that is not implemented yet. The runtime already
has the relay socket, registry, token validation, helper capability
registration, manager/planner relay paths, tool-call relay loop, per-agent
config scaffolding, and local relay smoke coverage. The remaining drift is
specific to Coding Agent local model execution.

## Implemented Baseline

- Runtime relay endpoint exists at `/local-relay/ws`.
- Helper registration and capability negotiation exist.
- DB-backed relay token validation exists.
- Manager and planner can use local relay model clients.
- `ToolCallingLoop.run/2` already supports relay-managed model turns and tool
  execution frames.
- `local_model_coding` exists, but it currently calls
  `ToolCallingLoop.run_direct/2`, which keeps model I/O inside the runtime
  process instead of sending the model turn through the Go helper.

## Remaining Target

```text
Platform runtime dispatch
  -> Runner.LocalModelCoding
  -> runtime relay dispatch frame
  -> outbound-connected local-runtime-helper
  -> local OpenAI-compatible endpoint, usually http://localhost:11434/v1
  -> runtime-owned tool policy/results/events
```

The helper should continue to dial the runtime service, commonly
`http://127.0.0.1:4000` in local development. No runtime work should introduce
or depend on `localhost:17654`.

## PR1 - Route local_model_coding through the relay helper

**Branch:** `codex/local-model-coding-relay-runner`

**Goal:** Replace the direct provider loop in
`Runner.LocalModelCoding.run_turn/3` with the relay-backed
`ToolCallingLoop.run/2` path, using the same helper/session mechanics already
used by manager and planner local relay clients.

**Files:**

| File | Remaining change |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex` | Stop using `ToolCallingLoop.run_direct/2` for normal runner execution. Build a relay dispatch frame with `runner_kind = "local_model_coding"`, provider profile, model, messages, tool definitions, and capability requirements. |
| `apps/orchestrator/lib/symphony_elixir/local_relay/registry.ex` | Verify helper selection can match `local_model_coding` registrations and required capabilities. Add only the missing filtering/selection logic, if current registry matching is insufficient. |
| `apps/orchestrator/lib/symphony_elixir/local_runtime/capabilities.ex` | Ensure required capabilities distinguish model I/O, tool calls, and runtime-managed tools for `local_model_coding`. |
| `apps/orchestrator/test/symphony_elixir/runner/local_model_coding_test.exs` | Add relay-backed happy path, missing-helper/offline-helper, and capability-mismatch cases. Existing direct provider tests should either move under smoke/harness naming or be limited to explicit direct-mode helpers. |

**Acceptance criteria:**

- A normal `local_model_coding` run sends a relay dispatch to an online helper.
- No matching helper returns a typed retryable local-runtime-offline style
  error, not a provider HTTP error.
- Tool calls still use runtime-owned validation, allowlists, result messages,
  and normalized coding events.
- Direct provider execution remains available only as a named test/smoke
  harness, not the default runner path.

## PR2 - Relay-mode local_model_coding smoke coverage

**Branch:** `codex/local-model-coding-relay-smoke`

**Goal:** Add integration coverage that proves the intended Coding Agent local
model path crosses the relay boundary.

**Files:**

| File | Remaining change |
|---|---|
| `apps/orchestrator/test/symphony_elixir/integration/local_model_coding_relay_smoke_test.exs` | New smoke using a fake relay helper. Assert dispatch frame shape, model/tool round trip, shell/apply_patch result handling, and final completion events. |
| `apps/orchestrator/lib/mix/tasks/local_model.coding_smoke.ex` | Label current direct endpoint smoke as direct/harness mode, and add a relay-mode smoke option only if useful for developer workflows. |
| `apps/orchestrator/WORKFLOW.local-e2e.md` | Update the local workflow to state the intended runtime path: runtime on `4000`, helper outbound relay connection, Ollama on `11434`. |

**Acceptance criteria:**

- The smoke would fail if `local_model_coding` bypasses the helper.
- Developer docs list only the intended ports for this flow: runtime relay
  service on `4000` and local model endpoint on `11434`.
- Existing direct smoke remains available but is explicitly documented as a
  model-client harness.

## PR3 - Error and diagnostic wording for local_model_coding relay failures

**Branch:** `codex/local-model-coding-relay-errors`

**Goal:** Make runtime errors distinguish relay-helper problems from local
model endpoint problems.

**Files:**

| File | Remaining change |
|---|---|
| `apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex` | Normalize missing helper, helper busy/offline, capability mismatch, and provider endpoint failure into distinct error atoms/codes. |
| `apps/orchestrator/lib/symphony_elixir/local_runtime/diagnostics.ex` | Add `local_model_coding` specific helper snapshots if current diagnostics only cover `local_relay`. |
| `apps/orchestrator/test/symphony_elixir/local_runtime/diagnostics_test.exs` | Add missing-helper versus model-endpoint-unavailable cases for local coding. |

**Acceptance criteria:**

- Missing helper means no relay helper is registered/online.
- Ollama unavailable means local model endpoint unavailable.
- No runtime diagnostic suggests binding or restarting `localhost:17654`.

## Cross-Repo Sequencing

1. Runtime PR1 is the core blocker for the long-term Coding Agent local model
   path.
2. Runtime PR2 should land with or shortly after PR1.
3. Platform should not fully route Coding Agent local model UI away from
   `/local-chat` until PR1 is available.
4. Platform and helper doc cleanup can land in parallel because they clarify
   existing architecture.

## Non-Goals

- Do not add an inbound helper HTTP daemon.
- Do not make runtime depend on platform's legacy `/local-chat` endpoint.
- Do not remove direct endpoint smoke harnesses; relabel them and keep them
  useful for narrow provider-client testing.
