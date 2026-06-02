# Dispatch Runner Enum Source Scope

## Premise

`manager/tools/dispatch_runner.ex:22-25` declares the `runner_kind`
enum as a **hardcoded** five-value list:

```elixir
ToolSupport.enum_schema(
  ["codex", "planner", "openclaw", "openclaw_ws", "computer_use"],
  "Runner kind to dispatch."
)
```

That violates the project's "no hardcoded enums — derive from the
single source of truth" rule (per the memory rule
[[feedback_no_hardcoded_enums]] and `Schema.ExecutionProfile.supported_runner_kinds/0`,
which already exists as a public function for this exact purpose).

A naive one-line fix — swap the literal for
`ExecutionProfile.supported_runner_kinds()` — fails. There's an
existing test (`manager/tools_test.exs:97-102`) titled "dispatch_runner
advertises only currently resolvable runner kinds" that asserts the
exact five-value list and specifically `refute "local_relay" in
runner_kinds`. That test encodes a real constraint: the manager's
dispatcher path cannot actually resolve every kind in the runtime
allowlist. Some kinds (local_relay, local_model_coding) need the
helper-daemon channel, which the manager doesn't go through.

## Current State

- `Schema.ExecutionProfile.supported_runner_kinds/0` returns 8 kinds:
  `codex, claude_code, openclaw, computer_use, manager, planner,
  local_relay, local_model_coding`.
- `dispatch_runner.ex` hardcodes 5 kinds:
  `codex, planner, openclaw, openclaw_ws, computer_use`.
- The intersection isn't quite right either:
  - `openclaw_ws` is in the dispatch_runner list but **not** in
    `supported_runner_kinds()` — it's a platform-only kind per
    `RUNTIME_NON_SCHEMA_PLATFORM_RUNNER_KINDS` in the cross-repo enum
    drift script.
  - `claude_code`, `manager` are in `supported_runner_kinds()` but
    **not** in the dispatch_runner list.
  - `local_relay`, `local_model_coding` are in
    `supported_runner_kinds()` but **deliberately not** in the
    dispatch_runner list (the test asserts this).

So three sets are in play:
1. **Runtime allowlist** (`supported_runner_kinds/0`).
2. **Platform routing-targets** (registry in
   `contracts/runner-kinds.ts`).
3. **Manager-dispatchable subset** — what the manager's
   `Tools.ToolSupport.dispatch_runner` can actually resolve.

The third set has no canonical home today.

## Target State

A new function — `ExecutionProfile.manager_dispatchable_runner_kinds/0`
(or similar) — owns the manager-dispatchable subset. The
`dispatch_runner` tool's parameters_schema calls it instead of
hardcoding. The function is the single source of truth for "what can
the manager dispatch to."

The test that pins the exact list moves with the data: it asserts
that the tool's enum equals the function's return value (not a hard
list), so future additions to the dispatchable set don't require
updating both files.

## Open Design Questions (Real Ones, Not Boilerplate)

### Q1 — Where does the dispatchable set actually come from?

There are three possible canonical homes:

- **(A) A new function on `Schema.ExecutionProfile`**, alongside
  `supported_runner_kinds/0`. Easiest. Risk: the dispatch path's
  capability changes (e.g., adding manager-side handling for
  `claude_code`) require two-PR coordination.
- **(B) Derive from `Runner` module introspection**. Each Runner
  module declares whether it's manager-dispatchable; the function
  scans the runner modules and returns the dispatchable set. Most
  principled, harder to set up.
- **(C) Read from `routing_rule` in the workspace**. The set of
  kinds the workspace has routing rules for is what the manager can
  actually dispatch to. Per-workspace dynamic. Most accurate at
  runtime, but the tool's JSON schema is built once per session — the
  set would have to be computed at tool-spec build time per session.

Default recommendation: **(A)** for this PR, with a code comment
pointing at (B) as the cleanup once Runner modules get a
`manager_dispatchable?/0` callback.

### Q2 — What about `openclaw_ws`?

It's in the current hardcoded list but not in `supported_runner_kinds`.
Two possibilities:

- The list is wrong and `openclaw_ws` should not be advertised
  (because the runtime can't actually dispatch it). Removing it would
  be the right move.
- The list is right and `supported_runner_kinds` is incomplete.
  Adding `openclaw_ws` to `supported_runner_kinds` would be the right
  move.

Need to check `manager/tool_support.ex`'s `dispatcher` function and
trace whether `openclaw_ws` actually flows through. Until that's
verified, keep it advertised (match today's behaviour).

### Q3 — Should the subset depend on the workspace's helper-daemon
status?

A user's workspace with no local helper daemon attached can't
actually dispatch `local_relay` or `local_model_coding` even if the
runtime supports them. Should the tool advertise based on
"theoretically supported" or "currently available"?

Default recommendation: advertise theoretically supported — the
dispatcher will error clearly if the daemon is offline. Adding
runtime-availability gating is a separate, larger scope.

## Phased Work

### DISPATCH-1 — Add `manager_dispatchable_runner_kinds/0`

- Add a public function on `Schema.ExecutionProfile` that returns the
  current hardcoded list (no behaviour change).
- Document why each value is in/out of the list (especially the
  exclusions: `local_relay` and `local_model_coding` need the helper
  daemon; `claude_code` and `manager` are not currently routed via
  the manager dispatcher).

### DISPATCH-2 — Use The Helper In `dispatch_runner.ex`

- Replace the hardcoded list with
  `ExecutionProfile.manager_dispatchable_runner_kinds()`.
- Update `manager/tools_test.exs:97-102` to assert against the
  helper's return value (not a hardcoded literal). The test stays
  meaningful and stops drift between the two.

### DISPATCH-3 (Optional) — Verify `openclaw_ws` Dispatchability

- Trace `manager/tool_support.ex`'s dispatcher to confirm whether
  `openclaw_ws` flows through.
- If not, remove it from the dispatchable list and the test asserts
  its absence (and an explanatory comment captures why).

## Non-Goals

- Reworking the runner registry across repos. The
  `runner-kind-drift-fix` work already addressed cross-repo
  consistency for the broader set. This scope is narrower: just the
  manager's dispatch surface.
- A workspace-availability gate (excluding kinds the helper daemon
  hasn't registered). Useful, but a separate concern.
- Auto-deriving the dispatchable set from Runner module
  introspection. Cleaner, but the tag-each-Runner refactor is a
  bigger change.

## Test Cases

### Unit: tool's enum matches `manager_dispatchable_runner_kinds/0`

```
given:  ExecutionProfile.manager_dispatchable_runner_kinds() returns
        a known list (e.g., ["codex", "planner", "openclaw",
        "openclaw_ws", "computer_use"])
when:   tool_specs() is built
then:   spec["inputSchema"]["properties"]["runner_kind"]["enum"]
        == ExecutionProfile.manager_dispatchable_runner_kinds()
```

### Unit: `local_relay` exclusion is intentional and documented

```
given:  ExecutionProfile.manager_dispatchable_runner_kinds()
then:   "local_relay" not in the result
and:    the function's docstring explicitly explains why (helper-
        daemon transport not routable from manager dispatcher)
```

### Unit: any future addition to `@supported_runner_kinds` triggers
a deliberate decision

```
given:  every kind in supported_runner_kinds()
then:   it is either in manager_dispatchable_runner_kinds() OR
        listed in a `@manager_undispatchable_kinds` literal with
        a reason comment.
        (Compile-time assertion or test ensures the union is
        complete — no kind silently absent.)
```

This is the load-bearing test: it forces future additions to the
runtime allowlist to make a deliberate yes/no decision on manager
dispatch, rather than silently inheriting "not dispatchable."

## Why This Started As A Code PR And Became A Scope Doc

A drive-by audit (transcript reference) flagged the hardcoded enum as
a violation of the no-hardcoded-enums rule. The naive fix — swap in
`supported_runner_kinds()` — would advertise four extra kinds that
the manager dispatcher cannot actually handle, and break an existing
test that pinned this exact constraint. The test's name ("currently
resolvable runner kinds") captures a real, undocumented design
boundary. Surfacing it as a named function with a comment is the
actual fix, not the one-line swap.

## Companion PRs

- PR #377 — the default-inheritance pattern this audit grew out of.
- Cross-repo enum drift work (`runner-kind-drift-fix`, merged in
  platform PR #527 and harper-server PR #538) — established the
  pattern of "canonical registry + drift checks across repos." This
  scope is the runtime-internal version of the same idea.
