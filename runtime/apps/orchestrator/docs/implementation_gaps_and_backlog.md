# Symphony Implementation Gaps and Backlog (Section-by-Section)

This set of notes maps the current Elixir implementation against the spec in this repo and records
how to implement missing pieces.

Legend:

- `Implemented` = already present in current runtime.
- `Partial` = present, but not fully aligned with the spec text.
- `Missing` = not currently implemented.

## 3. System Overview

- `Workflow Loader` — **Implemented**
- `Config Layer` — **Implemented**
- `Issue Tracker Client` — **Implemented** for Linear with extension adapter.
- `Orchestrator` — **Implemented**
- `Workspace Manager` — **Implemented**
- `Agent Runner` — **Implemented**
- `Status Surface` — **Implemented** (Phoenix dashboard + API)
- `Logging` — **Implemented**

What to add:

- Add explicit runtime diagrams and ownership boundaries for multi-host OpenClaw chains.
- Add a “write-path policy” document in repo docs for safety posture per environment.

## 4. Domain Model

- `Issue` normalization shape in tracker layer — **Implemented**, including labels and blockers.
- Orchestrator internals for live state/retries — **Implemented**.
- `RunAttempt`, `LiveSession`, `RetryEntry` explicit records — **Partial**
  - Some fields are tracked in state maps and updates but not serialized as first-class objects everywhere.

Implementation tasks:

- Add explicit structs for run attempts, retry metadata, and live session state snapshots.
- Normalize all status and session records into shared types to simplify status API contracts.

## 5. Workflow Specification

- `WORKFLOW.md` front matter and prompt split — **Implemented**
- defaults and `$VAR` + `~` expansion — **Implemented**
- strict config validation for startup and dispatch gating — **Implemented**
- dynamic reload with last-good fallback — **Implemented**

Implementation tasks:

- Add explicit schema coverage for all optional extension keys referenced in `server.port` and
  `worker.*` extension.
- Add a machine-readable error catalog for schema and parse failures for external observability.

## 6. Configuration and Hot Reload

- Precedence and environment indirection — **Implemented**
- path normalization (local + env expansion) — **Implemented**
- dynamic reload on change — **Implemented**
- invalid reload does not crash service — **Implemented**

Implementation tasks:

- Add hot-reload unit/integration tests for each extension group individually:
  `codex`, `agent`, `worker`, `server`.

## 7. Coordination/Domain Runtime

- Polling loop with periodic reconcile/dispatch/cleanup — **Implemented**
- claimed/running/retry runtime state — **Implemented**
- per-state concurrency (normalized state keys) — **Implemented**

Implementation tasks:

- Capture state transition audit entries (`dispatched`, `reconciled`, `retry_scheduled`, `completed`) for operator history.
- Add idempotent start/stop protections at each transition boundary.

## 8. Polling, Scheduling, and Reconciliation

- Candidate fetch and sorting — **Implemented**
- slot checks and per-state caps — **Implemented**
- blocker logic for Todo state — **Implemented**
- terminal/non-active checks for running reconciliation — **Implemented**
- stall timeout handling — **Implemented**
- normal continuation retry path — **Implemented**
- exponential backoff retry — **Implemented**

Implementation tasks:

- Add explicit state machine tests for the resume vs terminate distinction by issue outcome.
- Add explicit metrics for reason codes (`no_slots`, `terminal`, `non_active`, `stalled`, `error_*`).

## 9. Workspace Management

- Deterministic per-issue workspace pathing and reuse — **Implemented**
- sanitized identifier mapping and hooks — **Implemented**
- hook behavior and timeout semantics — **Implemented**
- startup cleanup of terminal workspaces — **Partial**
  - Present, but include explicit remote-host cleanup traces for auditability.

Implementation tasks:

- Add workspace manifest file per issue (for metadata + host + last runner + last config digest).
- Add retention policy controls for old workspaces (age/size-based pruning).

## 10. Agent Runner / App-Server Protocol

- Session startup sequence (`initialize`, `initialized`, `thread/start`, `turn/start`) — **Implemented**
- turn loop and continuation in one thread — **Implemented**
- parsing of usage/rate-limit payloads — **Implemented**
- unsupported tool handling and input-required failure path — **Partial**

Implementation tasks:

- Make protocol handling explicitly adapter-driven so non-Codex providers can be added
  (OpenAI Responses, OpenClaw, others).
- Add explicit message normalization layer to preserve compatibility despite protocol drift.

## 11. Tracker Integration

- Linear read operations and paging — **Implemented**
- missing auth/transport status handling — **Implemented**
- multi-adapter tracker abstraction exists (`memory` + Linear) — **Implemented**

Missing:

- Tracker write operations are intentionally handled by agents. Keep as designed unless your team wants first-class writes.

## 12. Prompt Construction

- Liquid-like prompt rendering with issue data and attempt context — **Implemented**
- issue key/value conversion and defaults — **Implemented**

Implementation tasks:

- Ensure template lint mode (strict unknown variables/filters fail) remains stable across future schema drift.

## 13. Observability

- structured logs, running/retry snapshot, Live dashboard, JSON API endpoints — **Implemented**
- HTTP observability extension controls and restart behavior — **Partial**

Implementation tasks:

- Normalize API response envelopes across all error paths and add machine-readable error codes.
- Add `status` endpoint for orchestrator health and dependency checks.
- Add optional streaming updates for React clients (SSE or WebSocket).

## 14. Safety

- path and cwd invariants, and workspace containment checks — **Implemented**
- secret indirection and no token logging — **Implemented**

Missing:

- explicit documented trust-level profiles (local, restricted, strict).
- stronger isolation options (container-level and network egress policy examples) in deployment guidance.

Implementation tasks:

- Add `SECURITY.md` with policy profiles and deployment hardening checklists.

## 17/18 Testing and Validation

- core tests exist and cover major orchestration behaviors — **Partial**

Implementation tasks:

- Add matrix coverage for all gap areas above, including simulated invalid workflow reload,
  host ping failures, and provider fallback scenarios.

---

## Immediate execution plan (90-day path)

1. Build provider abstraction for runner (Codex vs OpenClaw).
2. Add remote worker ping and backoff-aware host scoring.
3. Finalize React API contract and release a stable external dashboard API.
4. Add AWS deployment bundle (ECS + ALB + SSM + secrets) plus worker ingress model.
5. Add migration-safe docs and config schema versions.

