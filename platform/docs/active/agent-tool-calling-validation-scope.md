# Agent Evaluation And Tool Calling Validation Scope

## Status

Active scope.

This document captures the follow-up work for validating agent behavior across
different model backends, especially local and open-weight coding models that may
be less robust than cloud-hosted models.

Tool calling is the first and highest-signal validation slice because tool calls
are structured, persisted, and more deterministic than prose quality. The
underlying framework should not be limited to tool calling. It should be able to
grow into a broader agent evaluation system for message behavior, handoffs,
plans, memory writes, work-item mutations, latency, and runtime errors.

## Problem

OpenMacaw agents depend on model behavior that is partly natural-language and
partly structured. Tool availability and tool execution are not enough by
themselves: each configured model also needs to reliably choose the correct
tool, emit valid tool-call arguments, recover from tool results, and continue the
conversation through the same runtime path that a browser user exercises.

This is especially important when users change the underlying model. A local
model can appear healthy for plain chat while failing to call tools, calling the
wrong tool, producing invalid arguments, or bypassing the runtime helper path.
The same local model might also fail broader agent expectations, such as
creating a plan, escalating appropriately, writing memory, or avoiding a tool
call when no tool is needed.

## Goals

- Provide a manually enabled evaluation battery for agents.
- Exercise the same message path used by the browser dashboard.
- Record expected outcomes for each prompt without making the test format overly
  specific to one model or one tool implementation.
- Treat tool calling as the first built-in assertion family, not the entire
  evaluation framework.
- Keep token-consuming tests opt-in.
- Preserve enough run evidence to diagnose model, platform, runtime, and helper
  gaps.
- Leave room for the test catalog to move into the database as eval suites,
  prompts, assertions, and model comparisons grow.

## Non-Goals

- Do not run the battery automatically in regular CI by default.
- Do not assert on exact model prose unless the prose is the behavior being
  tested.
- Do not use LLM-judged evals as the first validation mechanism. Prefer
  deterministic persisted evidence first.
- Do not bypass the platform gateway, runtime launcher, orchestrator, or local
  runtime helper when validating end-to-end behavior.
- Do not require every test case to mutate external state. Prefer read-only
  probes by default and explicitly mark side-effecting cases.

## Required Workflow

The validation runner should simulate the browser workflow as closely as
possible:

1. Resolve the target agent, workspace, and auth context.
2. Call the platform API endpoint that starts the agent.
3. Open the same platform gateway websocket used by the dashboard.
4. Send the same chat message envelope the browser sends.
5. Let the platform forward the message to the runtime.
6. Let the runtime call the model.
7. Let tool execution happen through the runtime and local runtime helper when
   the selected tool is a local/helper-backed tool.
8. Poll persisted message/tool-call evidence from Supabase.
9. Write sanitized run artifacts for debugging.

The runner should not directly call runtime internals or invoke helper tools
itself. If a browser message would not reach a tool, the test should fail the
same way.

## Initial File-Backed Case Shape

A compact JSON or database-backed representation should be able to express:

```json
{
  "id": "git-run-repo-view",
  "enabled": true,
  "agent_id": "manager",
  "workspace_id": "default",
  "prompt": "Use the git tool to inspect the current repository remote.",
  "assertions": [
    {
      "type": "tool_call_observed",
      "tool": "git.run",
      "argument_hints": ["remote", "-v"]
    }
  ],
  "side_effects": "read_only",
  "timeout_ms": 90000,
  "tags": ["manager", "git", "local-helper"]
}
```

The schema should stay intentionally loose at first. The important invariant is
that each case names a prompt, the assertions we expect to satisfy, whether the
case is safe to run by default, and enough context to route the message through
the normal agent path.

The first assertions should be deterministic and based on persisted state. Tool
calling is a good initial fit because a pass/fail result can usually be derived
from tool-call rows, event logs, message parts, and terminal tool status.

## Assertion Types

Initial assertion support should focus on tool calls:

- `tool_call_observed`
- `tool_call_completed`
- `tool_call_failed_with`
- `no_tool_call`

The framework should leave room for broader agent behavior assertions:

- `message_contains`
- `message_json_matches_schema`
- `handoff_requested`
- `human_escalation_requested`
- `work_item_created`
- `work_item_state_changed`
- `memory_written`
- `plan_created`
- `runtime_error_absent`
- `cost_under_limit`
- `latency_under_ms`

The runner should not need all of these assertion types in the first PR. The
important design decision is that tool calling is one assertion family inside a
general evaluation case, not a separate database model that only understands
tools.

## Evidence Model

Short term, use persisted messages joined to tool-call rows as the source of
truth for tool assertions. A passing tool-calling case should be able to show:

- the user message was accepted by the gateway;
- the runtime produced an assistant turn;
- the expected tool call was persisted;
- the tool call reached a terminal result or a clear failure state;
- artifacts redact credentials, tokens, passwords, API keys, and authorization
  headers.

For broader eval assertions, observations should point at the same persisted
application evidence the product uses: messages, tool calls, work items, plans,
memory, escalation rows, runtime health, or event logs.

If a dedicated tool-call event table exists, tool assertions can prefer that
richer event stream. The fallback should remain message plus tool-call
persistence so the test keeps working across schema versions.

## Database Catalog Direction

A file-backed battery is enough for the first implementation, but the catalog
should likely move into Supabase once the test set grows. The database model
should be general-purpose for agent evaluation, not specific to tool validation.

The database-backed catalog would allow:

- tests to be enabled per workspace, agent, model, or tool family;
- users to add local validation prompts without editing repo files;
- run history to show regressions after model changes;
- side-effecting tests to require explicit manual enablement;
- UI affordances for selecting and running a subset of tests.
- broader assertions beyond tools without a second schema migration.

Candidate tables:

- `agent_eval_suite`
- `agent_eval_case`
- `agent_eval_case_assertion`
- `agent_eval_run`
- `agent_eval_run_case`
- `agent_eval_observation`

`agent_eval_case_assertion.assertion_type` can represent tool-call expectations
and later expand to message, work-item, memory, plan, escalation, latency, cost,
or runtime-health assertions.

An initial row shape could look like:

```text
agent_eval_case
  id
  suite_id
  name
  prompt
  target_agent_selector
  target_workspace_selector
  side_effect_level
  enabled_by_default
  timeout_ms
  tags

agent_eval_case_assertion
  id
  case_id
  assertion_type
  expected
  required
```

For tool calling, `expected` might be:

```json
{
  "tool": "git.run",
  "argument_hints": ["remote", "-v"]
}
```

The first PR does not need to add these tables. It should keep the file format
compatible with a future migration by avoiding ad hoc nested shapes that cannot
map cleanly to rows.

## Initial Tool Families

Start the first evaluation suite with tool-calling cases for the manager agent
because it has a broad but tractable tool surface. Representative tools to
cover:

- `git.run`
- `scheduled_task.list`
- `scheduled_task.read`
- `scheduled_task.create`
- `scheduled_task.update`
- `scheduled_task.delete`
- `dispatch_runner`
- `escalate_to_human`
- `snooze`
- `mark_done`

Read-only cases should be enabled first. Mutating tools should be present but
disabled until each case has a safe fixture or cleanup path.

After the tool-calling slice works, add broader agent behavior cases such as:

- a prompt that should produce no tool call;
- a prompt that should ask for human confirmation before a side effect;
- a prompt that should create a work item;
- a prompt that should produce a structured plan;
- a prompt that should escalate rather than fabricate missing information.

## Runner Requirements

- Dry-run by default; require an explicit `--run` or equivalent flag.
- Support selecting cases by id, tag, agent, or side-effect level.
- Support selecting suites or assertion types as the catalog grows.
- Print a concise summary suitable for manual use.
- Store detailed artifacts under an ignored run-artifacts directory.
- Redact secrets before writing artifacts.
- Fail clearly when auth, gateway connection, runtime launch, model response, or
  persisted assertion evidence is missing.
- Record model identity when available so users can compare local models.

## Open Questions

- Should the first database catalog live in platform only, or should runtime own
  some run observations?
- Should expected arguments be exact, partial, or predicate-based?
- How should tests declare cleanup for side-effecting tools?
- Should the UI expose this as an agent diagnostics panel, a workspace settings
  tool, or a developer-only script first?
- How should the runner treat tools that correctly ask for human confirmation
  instead of executing immediately?
- What assertion types are deterministic enough to include before introducing
  LLM-judged evals?
- Should `agent_eval_*` tables be global, workspace-scoped, or support both
  seeded global suites and workspace-local custom cases?

## First Implementation Slice

1. Add a file-backed manual runner that sends dashboard-equivalent messages.
2. Seed read-only manager cases for `git.run` and `scheduled_task.list`.
3. Persist sanitized artifacts outside git.
4. Report observed tool calls from Supabase persistence.
5. Leave disabled placeholders for side-effecting manager tools.
6. Shape the file format around `assertions`, not `expected_tool`, so it maps to
   future `agent_eval_case_assertion` rows.
7. Revisit the database catalog after the file-backed runner has real use.
