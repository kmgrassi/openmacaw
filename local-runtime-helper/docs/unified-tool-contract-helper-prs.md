# Unified Tool Contract — Helper PR Plan

Repo: `local-runtime-helper` (Go daemon).

Master design (canonical, cross-repo): [parallel-agent-runtime/docs/unified-tool-contract-scope.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/unified-tool-contract-scope.md).
Tracking PR for the master and all four per-repo plans:
[kmgrassi/parallel-agent-runtime#245](https://github.com/kmgrassi/parallel-agent-runtime/pull/245).

This file is the helper-side mirror of the per-repo plan, kept in this
repo so reviewers can land the PRs against the code that implements
them.

---

## PR1 — Unified tool spec shape on the wire

**Branch:** `feat/unified-tool-spec`

**Goal:** Helper accepts the canonical tool definition shape on
incoming dispatch frames and forwards canonical tool calls back to the
runtime, matching what runtime PR6 emits/expects.

**Wire shape (already documented in
`docs/universal-tool-calling-plan.md`, but now used uniformly across
all agent types — coding, planner, manager — not just coding):**

`tool_definitions` and `provider_tool_specs` are the effective
per-turn tool grants resolved by Platform/Runtime before dispatch. The
helper does not read policy templates, grant tables, role defaults, or
local tool bundles to decide what the model may call; it executes or
forwards only tools present in the dispatch frame. Runtime may include
optional provenance in metadata for diagnostics, but provenance is not
an authorization input in the helper.

```jsonc
// dispatch frame — runtime → helper
{
  "type": "dispatch",
  "tool_definitions": [
    {
      "name": "task.create",
      "description": "...",
      "parameters_schema": { /* JSON Schema */ },
      "execution_kind": "runtime",   // runtime | helper | external
      "metadata": { "grant_source": "agent_tool_grant" }
    }
  ],
  "tool_calling_mode": "runtime_managed", // or "helper_managed"
  "provider_tool_specs": [ /* effective tools pre-translated for the provider */ ]
}

// tool_call_request — helper → runtime
{
  "type": "tool_call_request",
  "tool_calls": [
    { "id": "call_1", "name": "task.create", "arguments": { /* parsed map */ } }
  ]
}

// tool_call_result — runtime → helper
{
  "type": "tool_call_result",
  "tool_call_id": "call_1",
  "success": true,
  "output": { /* canonical result map */ }
}
```

**Acceptance criteria:**
- [ ] Helper parses `tool_definitions` and uses `provider_tool_specs`
  when present (runtime has already translated)
- [ ] Helper emits `tool_call_request` frames in canonical shape
- [ ] Helper consumes `tool_call_result` frames generically (no
  agent-type-specific code paths)
- [ ] `tool_calling_mode: "runtime_managed"` works for all agent
  types — replaces the manager-specific `manager_runtime` mode and
  the coding-specific `helper_managed` carve-outs

**Sequencing:** Lands in lockstep with runtime PR6 + PR7. The
runtime↔helper protocol is internal infrastructure under our control,
not an external API, so the project's "no backwards compatibility
shims" rule applies (see CLAUDE.md): the wire shape change is atomic
across both repos in a single coordinated release. Helper does **not**
accept the legacy dispatch shape in parallel — runtime stops sending
the legacy shape in the same release the helper stops accepting it,
and any orchestrator/helper version skew during deploy is handled by
the existing capability-negotiation failure path (`capability_missing`
error), not by dual-format parsing.

---

## PR2 — Generic runtime-executes-tools mode

**Branch:** `feat/runtime-managed-tools`

**Goal:** Helper supports a single `runtime_managed` mode where any
tool call is sent to the runtime regardless of agent type. Removes
agent-type-specific tool-execution branching in helper code.

**Routing rule (single source of truth — `execution_kind` on each
tool definition):**

- `execution_kind: "helper"` → helper executes locally and never emits
  a `tool_call_request` for that tool. Coding tools like `shell.exec`,
  `repo.list`, `repo.read_file`, `repo.search`, `apply_patch` live
  here.
- `execution_kind: "runtime"` → helper forwards a `tool_call_request`
  frame to the runtime, which executes against Supabase / GitHub / DB
  and returns a `tool_call_result`. Manager tools (`merge_pr`,
  `dispatch_runner`, `snooze`, …) and planner DB tools (`plan.create`,
  `task.create`, …) live here.
- `execution_kind: "external"` → helper forwards a `tool_call_request`
  to the runtime; runtime calls the external system. Reserved for
  future tools that hit third-party APIs through runtime-held
  credentials.

The agent type does **not** factor into routing. A single agent can
mix `helper`/`runtime`/`external` tools in one tool set (e.g. a
planner agent using both `task.create` (runtime) and `repo.search`
(helper)) and the helper routes each call by its `execution_kind`,
not by agent type.

**Files:**
- `internal/agent/*` — wherever the helper currently has separate
  code paths for "manager tool" vs "coding tool" execution. Collapse
  to one dispatcher that switches on `execution_kind` of the
  individual effective tool definition (looked up by tool name in the
  dispatch frame's `tool_definitions[]`).
- `internal/protocol/*` — drop the `manager_tool_calling` capability;
  replace with `runtime_managed_tools` capability advertised by the
  helper. The capability means "I can forward `runtime`/`external`
  tool calls to the runtime over the relay" — independent of agent
  type.

**Acceptance criteria:**
- [ ] Helper has no agent-type branching for tool execution; routing
  is a pure function of `execution_kind` on the tool definition.
- [ ] `execution_kind: "helper"` tools execute locally without
  emitting `tool_call_request` frames.
- [ ] `execution_kind: "runtime"` and `"external"` tools always emit
  `tool_call_request` frames and wait for `tool_call_result`.
- [ ] An agent with a mixed tool set (some helper, some runtime) is
  exercised end-to-end in tests — the same model turn produces both
  locally-executed tool calls and runtime-forwarded tool calls.
- [ ] Capability negotiation reports `runtime_managed_tools: true`
  instead of `manager_tool_calling`.
- [ ] All three agent types (coding, planner, manager) work
  end-to-end through the helper.

**Sequencing:** Depends on PR1.
