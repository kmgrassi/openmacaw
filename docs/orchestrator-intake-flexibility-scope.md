# Orchestrator Intake Flexibility — Scope

Status: proposed
Owner: TBD
Related: [`openmacaw-vs-openclaw-hermes.md`](openmacaw-vs-openclaw-hermes.md)

## Problem

The orchestrator is meant to be the routing mechanism: agents describe work,
the orchestrator decides where and when it runs. In practice the relationship
is inverted. The tool-call surface agents use to feed items in
(`task.create`, `dispatch_runner`) requires them to speak the orchestrator's
internal vocabulary — concrete runner kinds, transports, poll cadences,
state/poll coupling — so the LLM agents end up doing the routing and the
orchestrator just records their choices. The result is a surface that is
rigid where it should be lenient (intake) and delegating where it should be
authoritative (routing).

Concretely:

- `task.create`
  (`runtime/apps/orchestrator/lib/symphony_elixir/planner/database_tool_specs.ex`)
  exposes ~25 fields including a four-level routing hint
  (`runner_family` → `execution_location` → `transport` → `runner_kind`)
  that requires infrastructure knowledge the planner cannot ground.
- `dispatch_runner`
  (`runtime/apps/orchestrator/lib/symphony_elixir/manager/tools/dispatch_runner.ex`)
  requires a pre-existing `work_item_id` and a hardcoded `runner_kind` enum.
  The manager cannot react to new information by spinning up work; an item
  row must exist first.
- The manager-pickup contract (state must be `running`/`awaiting_review`
  AND `next_poll_at` must be set) is encoded only in tool-description prose.
  A `todo` item with no poll time is silently never picked up — the most
  common failure mode is invisible.
- Three different runner-kind vocabularies exist:
  `dispatch_runner`'s enum (`codex, planner, openclaw, openclaw_ws,
  computer_use`), the routing hint's enum (`codex, openclaw, computer_use,
  manager, planner, local_relay, local_model_coding`), and
  `SymphonyElixir.Schema.ExecutionProfile.supported_runner_kinds()`. Even a
  perfectly attentive agent cannot be consistent across them.
- Validation failures bounce back as `validation_failed` feedback the agent
  must parse and re-call, costing a tool round-trip for repairs that are
  mechanical (case mismatches, scalar-vs-list).

## Design principles

1. **The orchestrator stays deterministic.** No LLM calls in the dispatch
   loop. LLM agents decide *what work exists and why*; the orchestrator
   deterministically decides *where and when it runs*. Routing resolution is
   lookup tables and config, living next to the existing eligibility gates in
   `DispatchPolicy`.
2. **Lenient intake, strict storage.** Tool inputs tolerate LLM output noise;
   the `work_items` row is always canonical. This is *not* a
   backwards-compatibility shim (see runtime/CLAUDE.md): there is exactly one
   canonical stored form, and the boundary normalization handles model output
   variance, not legacy formats.
3. **One vocabulary, one normalizer.** All intake paths (planner tools,
   manager tools, `POST /api/v1/items`, platform `POST /api/work-items`,
   webhooks) converge on a single normalization module and a single
   runner-kind/intent vocabulary sourced from
   `SymphonyElixir.Schema.ExecutionProfile`.

## Scope

### 1. Intent-based routing resolution (highest leverage)

Make `runner_kind` optional everywhere agents speak. Agents supply an
`intent` (e.g. `implement`, `review`, `test`, `browse`, `remediate`) and the
orchestrator resolves the concrete runner via a deterministic mapping
(static table + workspace execution-profile config), implemented alongside
the gates in
`runtime/apps/orchestrator/lib/symphony_elixir/orchestrator/dispatch_policy.ex`.
Explicit `runner_kind` remains as an override. Adding a runner becomes a
mapping-table change, not a tool-schema change across N surfaces.

Collapse the four-level routing hint: `intent` (+ optional
`execution_location`) is the agent-facing surface; `runner_family` and
`transport` are derived server-side and removed from agent-facing schemas.

### 2. Minimal `delegate` tool for agents

One slim tool for "hand this work to the orchestrator":

- Required: `instructions` (free text).
- Optional: `title`, `priority`, `intent`, `depends_on`, `repository`,
  `when` (`now` | ISO timestamp | omit for plan-only).

Everything else (`workspace_id`, identifiers, plan linkage, poll cadence,
state) is resolved or defaulted server-side — most of that defaulting
already exists in `planner/database_tools.ex`. The full `task.create`
schema survives as the power/API surface; `delegate` is what shapes agent
behavior, because the schema agents see in their tool list is the strongest
prompt they get.

`when: "now"` (or near-future timestamp) sets the manager-pickup fields
(`state`, `next_poll_at`) atomically, eliminating the silent
todo-with-no-poll trap.

### 3. Fuse create + dispatch

Let the manager dispatch work that doesn't yet have a row: either
`dispatch_runner` accepts an inline `work_item: {title, instructions}` and
creates the row as part of dispatch, or `delegate` gains an
`immediate: true` mode. Idempotency for inline creates keys on a content
hash, preserving the double-dispatch protection in
`manager/tool_support.ex` (currently keyed on
`work_item_id + runner_kind + intent`).

### 4. Coerce instead of reject at the tool boundary

Mechanical near-misses are normalized, not bounced: enum case-folding,
scalar→single-element-list wrapping, state-name casing, label objects vs
strings. The tool result reports what was coerced
(`"normalized": {"labels": "wrapped scalar in list"}`) so the agent learns.
Hard errors are reserved for genuinely ambiguous input. Implemented in the
shared normalizer (extend `work_item/mapper.ex`), applied identically on
every intake path.

### 5. Close the feedback loop

- `delegate` / `task.create` return an expected-pickup summary computed from
  the manager cadence and the dispatch gates the item currently fails
  ("eligible at next tick (~60s)" / "blocked: depends_on X unresolved" /
  "not manager-runnable: state=todo").
- New `task.status` read tool exposing the same dispatch-eligibility
  reasoning `DispatchPolicy` already computes internally, so a planner can
  check whether and why its delegated work is moving.

### 6. Unify the runner-kind vocabulary

One enum, sourced from
`SymphonyElixir.Schema.ExecutionProfile.supported_runner_kinds()`, used by
every agent-facing schema and prompt. Resolve the `openclaw_ws` /
`local_model_coding` discrepancies at the schema source and the
`SymphonyElixir.ExecutionProfile` platform-to-runtime normalizer per the
no-shims rule (change everywhere in one PR set, including any stored values +
DB constraints in harper-server).

### 7. Agent context fixes (prompts and tool descriptions)

The schemas above remove most of the need for routing knowledge, but the
remaining context must actually be given to the agents:

- **Manager prompt**
  (`runtime/apps/orchestrator/priv/prompts/manager-system-v1.md`) explains
  *when* to dispatch but never *how to choose* `runner_kind`, and its worked
  examples are PR-shepherding-specific. After item 1, the prompt should
  document the intent vocabulary (one line per intent) instead.
- **Planner** has no system-prompt routing guidance at all — everything it
  knows about manager pickup and routing lives in one dense `task.create`
  description. After item 2, the `delegate` description should carry the
  intent vocabulary and the `when` semantics; the pickup contract stops
  being prose because it becomes atomic behavior.
- **Shared intent vocabulary** is defined once (runtime config or the
  execution-profile schema) and injected into both tool descriptions and
  prompts, so prompts cannot drift from the mapping table.

## Non-goals

- No LLM call anywhere in the dispatch loop or intake normalization.
  (A freeform "parse this markdown plan into tasks" intake agent was
  considered and deferred; items 1–3 capture most of the value.)
- No dual-format/legacy-alias support. Canonical forms change everywhere at
  once per the runtime no-shims rule.
- No change to dispatch eligibility semantics (states, concurrency caps,
  dependency blocking) — only to how items enter and how routing fields are
  resolved.

## Sequencing

1. Item 6 (vocabulary unification) — prerequisite, small, mechanical.
2. Item 1 (intent → runner resolution in `DispatchPolicy`) + item 4 (shared
   normalizer) — the deterministic core.
3. Item 2 (`delegate`) + item 3 (create+dispatch fusion) + item 7 (prompt and
   description updates) — the agent-facing surface, bundled per the runtime
   PR-bundling convention since they share one review surface.
4. Item 5 (status/feedback) — independent, can land any time after 2.

## Key files

| Concern | File |
|---|---|
| Dispatch gates + (new) intent resolution | `runtime/apps/orchestrator/lib/symphony_elixir/orchestrator/dispatch_policy.ex` |
| Planner tool specs | `runtime/apps/orchestrator/lib/symphony_elixir/planner/database_tool_specs.ex` |
| Planner tool execution / defaulting | `runtime/apps/orchestrator/lib/symphony_elixir/planner/database_tools.ex` |
| Manager dispatch tool | `runtime/apps/orchestrator/lib/symphony_elixir/manager/tools/dispatch_runner.ex` |
| Manager dispatch execution + idempotency | `runtime/apps/orchestrator/lib/symphony_elixir/manager/tool_support.ex` |
| Manager prompt | `runtime/apps/orchestrator/priv/prompts/manager-system-v1.md` |
| Normalization | `runtime/apps/orchestrator/lib/symphony_elixir/work_item/mapper.ex` |
| Runner-kind allowlist / exported schema enum | `runtime/apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex` |
| Platform-to-runtime runner normalization | `runtime/apps/orchestrator/lib/symphony_elixir/execution_profile.ex` |
| HTTP intake | `runtime/apps/orchestrator/lib/symphony_elixir/tracker/api.ex` |
| Platform contracts | `platform/contracts/work-items.ts` |
| Platform intake route | `platform/apps/api/src/routes/work-items.ts` |
