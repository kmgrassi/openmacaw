# Local Coding Relay — Wire-Contract Unification & End-to-End Tool Loop Scope

## Goal

Make Runtime the canonical owner of the **local-relay wire contract** and close
the small set of gaps that prevent the coding agent's tool-calling loop from
running cleanly through `Runtime → local_relay → helper → workspace` in
production. This is **not** a re-scope of local-model coding, the unified tool
contract, or relay infrastructure — those are already covered. It scopes the
specific cross-repo glue work that nothing else owns.

**Cross-repo companions:**
- Helper: `local-runtime-helper/docs/relay-contract-parity-scope.md`
- Platform: `parallel-agent-platform/docs/active/local-chat-deprecation-scope.md`

## What's already scoped (do not re-scope)

| Concern | Owner doc |
| --- | --- |
| Local model coding runner & tool surface | `docs/local-model-coding-runner-scope.md` (platform, shipped); `docs/local-model-filesystem-tooling-scope.md` (runtime) |
| Unified tool contract across providers | `docs/unified-tool-contract-scope.md` + per-repo `*-prs.md` |
| Relay infrastructure (socket, auth, registry) | `docs/cloud-local-relay-pr-plan.md`, `docs/local-model-e2e-scope.md` |
| `manager_tool_calling` → `runtime_managed_tools` rename | `docs/local-model-readiness-runtime-prs.md` PR1 (already shipped) |
| Helper-side protocol parity test (partial) | `local-runtime-helper/docs/cloud-deployment-pr-plan.md` |

## Gaps this scope addresses

1. **Wire-contract field-name drift.** `docs/local-relay-protocol.schema.json`
   uses `"protocol": 1` in the `registered` frame. Helper Go code
   (`internal/protocol/protocol.go`) embeds `SchemaVersion = "1"` in
   `BaseFrame`. Two field names for the same concept; no doc declares which
   is canonical.
2. **No Elixir-side parity test.** The helper has a partial parity-test plan;
   the runtime side has none. Drift can land without CI catching it.
3. **No exportable wire-contract artifact.** The schema lives only in the
   runtime repo; helper has to read across repos or duplicate. There's no
   single artifact both repos consume.
4. **End-to-end coding tool-call frame flow is documented piecewise.** No
   single doc walks the on-wire frames for an `apply_patch` invocation
   (helper-local execution, no `tool_call_request` round-trip) versus a
   runtime-managed tool call (`tool_call_request` → `tool_call_result`
   round-trip) with concrete examples side by side. Engineers picking up
   this work have to assemble it from four sources and frequently
   mis-model the wire direction for helper-local tools (the unified-tool
   contract assigns coding tools `execution_kind: "helper"`, so they
   execute on the helper and never emit `tool_call_request` —
   `docs/unified-tool-contract-helper-prs.md` §PR2 routing rules).
5. **No coding-agent smoke test that exercises the full loop.**
   `local-model-readiness-runtime-prs.md` PR4 references "smoke tests" but
   doesn't detail an apply_patch-through-helper-with-workspace-mutation case.

## Target architecture (recap, not re-scope)

```
Web → Platform API (routing, profiles, tool grants)
    → Runtime (runner loop, policy, event normalization)
    → local_relay frames (this doc)
    → local-runtime-helper (model I/O + local tool exec)
    → Ollama / workspace
```

Runtime owns the relay wire contract. Helper conforms. Platform routes coding
traffic via Runtime, not via the dev `/local-chat` shortcut (see Platform
companion doc).

## PR plan

Each PR is small and independently mergeable. Helper-side counterparts in the
helper companion doc are noted where relevant.

### PR1 — Canonicalize the wire-contract version field

**Pick one name and remove the other.** Recommendation: `schema_version`
(string), since helper code already uses it in `BaseFrame` and a string
version is friendlier to non-integer evolutions (`"1.1"`, `"2-rc"`).

- Update `docs/local-relay-protocol.schema.json` so every frame carries
  `schema_version: "1"` instead of (or in addition to, then dropping)
  `protocol: 1` in the `registered` frame. The schema becomes the canonical
  source of truth for field naming.
- Update Elixir emitter modules under `apps/orchestrator/lib/...` to write
  `schema_version`.
- Update Elixir parsers to require `schema_version` and reject `protocol`. No
  backward-compat shim per repo convention.
- Update fixtures and unit tests.

**Pairs with helper PR1** — both sides flip in lockstep so the wire never
disagrees.

### PR2 — Publish the wire-contract artifact

The schema becomes a first-class artifact this repo exports.

- Move `docs/local-relay-protocol.schema.json` to a stable path
  (`contracts/local-relay-protocol.schema.json` or similar — pick a path
  helper can fetch reliably).
- Add a small CI step that asserts the Elixir wire types match the schema
  (round-trip serialize → JSON Schema validate).
- Document the export path in this doc and in the helper's parity-scope doc
  so downstream consumers have one URL to track.

### PR3 — Elixir-side parity test

Mirror what `cloud-deployment-pr-plan.md` plans for helper.

- Add `apps/orchestrator/test/relay_protocol_parity_test.exs`.
- One canonical fixture file per frame type: `register`, `registered`,
  `heartbeat`, `dispatch`, `tool_call_request`, `tool_call_result`, `error`,
  `complete`. Same fixtures helper uses.
- Test asserts each fixture round-trips through the Elixir struct and
  passes JSON-Schema validation against PR2's artifact.

### PR4 — Document the coding-agent tool-call frame flow

The novel docs work. Add `docs/local-relay-coding-tool-flow.md` with two
side-by-side concrete examples, because the wire direction differs by
`execution_kind` and engineers regularly mis-model it.

**Example A — `apply_patch` (`execution_kind: "helper"`, helper-local).**
The helper runs the model loop AND executes the tool. No
`tool_call_request`/`tool_call_result` round-trip with runtime; runtime
sees only the dispatch, observability/stream frames, and the final
`complete`.

```
1. Runtime → helper: dispatch
   { schema_version: "1", type: "dispatch", agent_id: "...",
     tool_definitions: [
       { name: "apply_patch", execution_kind: "helper",
         inputSchema: { ... } },
       ...
     ],
     provider_tool_specs: [ ... ],
     messages: [...] }

2. Helper runs the model call locally; model emits an apply_patch call.

3. Helper executes apply_patch on the workspace locally.
   No frame to runtime — execution_kind: "helper" means the helper
   never emits a tool_call_request for this tool
   (docs/unified-tool-contract-helper-prs.md §PR2).

4. Helper feeds the tool result back into the model loop locally and
   continues until the model produces a final assistant message.

5. Helper → Runtime: stream/observability frames carrying assistant
   deltas and any tool-execution telemetry the relay protocol exposes
   for helper-local tools (the precise event shape is fixed by
   PR2's published schema artifact).

6. Helper → Runtime: complete
   { schema_version: "1", type: "complete", agent_id: "...",
     final_message: { ... } }
```

**Example B — runtime-managed tool (`execution_kind: "runtime"`, e.g.
manager `merge_pr`, planner `task.create`).** Helper forwards the tool
call to runtime; runtime executes and returns the result.

```
1. Runtime → helper: dispatch
   { schema_version: "1", type: "dispatch", agent_id: "...",
     tool_definitions: [
       { name: "task.create", execution_kind: "runtime",
         inputSchema: { ... } },
       ...
     ],
     ... }

2. Helper runs the model call; model emits a task.create call.

3. Helper → Runtime: tool_call_request
   { schema_version: "1", type: "tool_call_request",
     call_id: "...", name: "task.create", arguments: { ... } }

4. Runtime executes task.create against the platform/DB.

5. Runtime → helper: tool_call_result
   { schema_version: "1", type: "tool_call_result",
     call_id: "...", ok: true, output: { ... } }

6. Helper feeds the result back into the model loop, eventually
   emits `complete` (as in Example A step 6).
```

Include error variants for both (`tool_call_result.ok: false` for B;
helper-side tool-execution failure surfaced via the observability/stream
channel for A), the approval-interruption case (if applicable), and the
helper-disconnects mid-call recovery for each example.

This doc is referenced from existing scope docs but lives here as the
single source of truth, and explicitly contrasts the two wire shapes so
the routing rule from the unified-tool contract has one concrete
illustration on this side of the wire.

### PR5 — Coding-agent smoke test (full loop)

A runtime-driven smoke test that proves PR1–PR4 hold end-to-end.

- Spin up an in-process or test-mode helper with a stub Ollama (replays
  pre-canned model output that includes an `apply_patch` tool call and a
  final answer).
- Provision a temporary workspace dir.
- Drive Runtime to dispatch a coding task whose `tool_definitions`
  include `apply_patch` with `execution_kind: "helper"`.
- Assert:
  - The workspace was mutated by `apply_patch` (the canonical
    end-to-end check).
  - Runtime sees the dispatch out, observability/stream events in, and
    a final `complete` — and does **not** see a `tool_call_request` or
    `tool_call_result` frame for `apply_patch` (helper-local tools
    must not round-trip through runtime;
    `docs/unified-tool-contract-helper-prs.md` §PR2).
  - The `complete` frame carries the final assistant message produced
    by the local model loop.
- For coverage of the runtime-managed path, add a second smoke (or a
  second case in the same test) that uses an `execution_kind: "runtime"`
  tool (e.g. `task.create`) and asserts the `tool_call_request` →
  `tool_call_result` pair does appear in the relay event stream.
- Run in CI; mark as a smoke gate for the local-coding path.

## Sequencing & cross-repo dependencies

```
Runtime PR1  ──────────►  Helper PR1   (paired wire-name flip)
Runtime PR2  ──────────►  Helper PR2   (helper consumes the artifact)
Runtime PR3  ─┐          Helper PR3   (parity tests use shared fixtures)
              └──┐
Runtime PR4  ───┴───►   (docs only; no helper dep)
Runtime PR5  ───────►   (consumes PR1–PR4; depends on Helper PR1+PR2 merging)
```

Platform's `/local-chat` deprecation (companion doc) depends on **Runtime
PR1+PR5** completing — the relay path needs to be solid before Platform
removes its fallback.

## Out of scope

- Sandbox container runner (already scoped in
  `parallel-agent-platform/docs/active/production-container-tool-execution-scope.md`)
- Tool grants & policy (`agent-tool-grant-data-model-scope.md` family)
- Manager / planner local-model paths (separate scopes)
- Cloud relay token validation beyond what `cloud-local-relay-pr-plan.md`
  already covers
