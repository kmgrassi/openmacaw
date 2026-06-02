# Local Model Filesystem Tooling Scope

This document scopes the work required to let a locally hosted model act like a
coding agent that can inspect and edit a workspace. The feature crosses three
surfaces:

- Platform: tool definitions, agent assignment, model context, routing, UI, and
  persistence.
- Runtime: local model tool-calling loop, execution policy, event normalization,
  and relay protocol.
- CLI/local helper: registration of the local workspace root and any on-machine
  process that actually reads files, runs commands, or applies patches.

The important boundary is that Platform API should not become a general-purpose
filesystem or shell executor. It can execute database tools in-process, but
coding tools must run in a local runtime/helper process with an explicit
workspace root and policy.

## Goal

Allow a coding agent backed by a local OpenAI-compatible model to:

1. Receive the available coding tool schemas in the model request context.
2. Emit native tool calls when the model supports them, with prompt-based
   fallback only when needed.
3. Execute `shell.exec` and `apply_patch` against the selected local workspace.
4. Persist and display tool calls, outputs, failures, approvals, and file
   changes in Platform.

Target model path:

```text
User message
  -> Platform resolves agent, workspace, session, execution profile, tools
  -> Platform sends dispatch/local-chat request with tool definitions
  -> Runtime/helper sends tools to local model
  -> Model emits tool_calls
  -> Runtime/helper executes shell/apply_patch inside workspace policy
  -> Runtime/helper appends tool results and continues the model loop
  -> Platform persists final answer and normalized tool events
```

## Non-Goals

- Do not run arbitrary shell commands inside the Platform API process.
- Do not expose the local model endpoint or local filesystem over public HTTP.
- Do not add many granular filesystem tools for the MVP. Prefer `shell.exec`
  plus `apply_patch`; listing, reading, searching, git status, builds, and tests
  flow through `shell.exec`.
- Do not rely on model-authored `workspace_id`, `user_id`, or `session_id` as
  authoritative. Those IDs must come from runtime context.
- Do not build container-grade multi-tenant isolation in the first pass.

## Current State

Recent local work proved the database-tool path:

- Local chat can parse XML-ish pseudo tool calls from the model.
- Database tools can execute in Platform API when `execution_kind = database`.
- Runtime context should be authoritative for `workspace_id`; model-supplied IDs
  are advisory at most.

That work does not make filesystem access available. Filesystem and patch tools
need a separate execution path because they operate on the user's machine.

Existing docs and code indicate partial runtime groundwork:

- Platform docs already describe universal tool calling and a local model coding
  runner.
- Runtime has provider/tool-call normalization and local relay tool-call
  protocol concepts.
- Runtime has or has had branch work for a workspace-scoped `shell.exec`
  executor and local model coding loop.
- Local helper docs already scope local tool execution, but that capability has
  to be reconciled with the current runtime architecture before implementation.

Each implementation PR should verify what is already merged to `main` before
copying branch-local assumptions.

## Tool Surface

MVP tools:

| Tool | Owner | Purpose |
|---|---|---|
| `shell.exec` | Runtime/helper | Inspect the workspace and run commands: list files, read files, search code, inspect git state, run tests/builds, and collect diagnostics. |
| `apply_patch` | Runtime/helper | Edit the workspace by applying a structured patch with path safety checks. |

The model should treat `shell.exec` as the read/inspect/run tool. Examples:

- `ls`, `find`, and `rg --files` to list files.
- `rg` to search code.
- `sed -n`, `cat`, and `nl` to read file contents.
- `git status`, `git diff`, and `git log` to inspect repository state.
- `pnpm test`, `npm test`, `mix test`, `go test`, or similar commands to
  verify changes.

The model should treat `apply_patch` as the edit tool. It should use
`apply_patch` for source, config, docs, and test file changes instead of
constructing shell commands that write files. Shell commands may still create
generated artifacts as part of build/test tooling, but intentional repository
edits should flow through `apply_patch` so Runtime can validate paths, summarize
file changes, and apply approval policy consistently.

Recommended `shell.exec` input:

```json
{
  "type": "object",
  "required": ["argv"],
  "properties": {
    "argv": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1
    },
    "cwd": { "type": "string" },
    "timeout_ms": { "type": "integer", "minimum": 1000, "maximum": 600000 },
    "env": {
      "type": "object",
      "additionalProperties": { "type": "string" }
    }
  },
  "additionalProperties": false
}
```

Recommended `apply_patch` input:

```json
{
  "type": "object",
  "required": ["patch"],
  "properties": {
    "patch": { "type": "string" }
  },
  "additionalProperties": false
}
```

Provider-facing names need to respect provider constraints. Platform can store
canonical slugs like `shell.exec`, but the model request may need sanitized
function names like `shell_exec` with a reverse mapping for execution.

## Required PRs

### Platform PR 1: Coding Tool Definitions and Assignment

Branch suggestion: `codex/local-model-coding-tool-definitions`

Responsibilities:

- Seed or migrate tool definitions for `shell.exec` and `apply_patch`.
- Store canonical slug, provider-safe function name, description, JSON Schema,
  `execution_kind`, `runner_kind`, and `enabled`.
- Assign coding tools to local coding agents by default, without assigning them
  to planning/database-only agents.
- Add tests for default assignment and provider-name mapping.

Acceptance criteria:

- A coding agent resolves both coding tools from the database.
- Provider tool specs include schemas, not only tool names.
- The code can map a model call to `shell_exec` back to canonical `shell.exec`.
- No `ON CONFLICT (slug)` migration is used unless the DB has the matching
  unique constraint.

### Platform PR 2: Context and Dispatch Contract

Branch suggestion: `codex/local-model-coding-context-dispatch`

Responsibilities:

- Pass authoritative context to local model runs: `workspace_id`, `user_id`,
  `session_id`, `agent_id`, and resolved workspace root reference.
- Include tool definitions in local-chat or runtime dispatch payloads.
- Keep user/workspace/session IDs out of model-owned tool arguments except where
  required for display or compatibility.
- Add validation that local coding tools require a runtime/helper execution
  target, not Platform API database execution.

Acceptance criteria:

- Logs show model requests include `tools` for local coding agents.
- Runtime/helper dispatch receives the same normalized tool definitions.
- Workspace context is derived from the authenticated request/session, not from
  model output.
- Invalid or missing execution target fails before the model is asked to call
  tools.

### Platform PR 3: Persistence, Status, and Approvals UI

Branch suggestion: `codex/local-model-tool-call-observability`

Responsibilities:

- Persist local coding tool calls with input, output summary, status, timings,
  error code, and correlation IDs.
- Render tool events in chat/status views: command started, output delta,
  command completed, patch begin/end, failure, timeout, cancellation.
- Add approval state if `shell.exec` can cross a policy boundary.
- Avoid storing full secret values or excessively large command output.

Acceptance criteria:

- A local coding run leaves `tool_call` records for `shell.exec` and
  `apply_patch`.
- The UI distinguishes model text, assistant tool calls, tool results, and final
  assistant responses.
- Failed tools return normal tool-result content to the model instead of
  failing the whole chat request unless the runtime itself is unavailable.

### Platform PR 4: Local Coding Settings and CLI Hand-Off

Branch suggestion: `codex/local-model-coding-settings`

Responsibilities:

- Add agent/workspace settings for local coding execution.
- Show whether the local helper/runtime is online and what workspace root is
  registered.
- Provide copyable CLI registration commands or launch instructions.
- Surface model tool-call capability: native tools, prompt fallback, or no tool
  support.

Acceptance criteria:

- Users can tell which local machine/workspace will execute filesystem tools.
- The UI prevents enabling coding tools without a registered local execution
  target.
- The settings flow does not require exposing local model credentials to the
  browser.

### Runtime PR 1: Provider Tool-Calling Loop

Branch suggestion: `codex/local-model-tool-loop`

Responsibilities:

- Normalize Platform tool definitions into provider-specific tool specs.
- Send `tools` to OpenAI-compatible local models when native tool calling is
  supported.
- Parse non-streaming and streaming `tool_calls`.
- Append assistant tool-call messages and tool result messages for the next
  model turn.
- Enforce max iterations and repeated-call protection.
- Provide prompt-based fallback only when the provider/model cannot accept
  native tools.

Acceptance criteria:

- Unit tests cover single tool call, multiple calls, invalid tool name, malformed
  arguments, repeated calls, and max iterations.
- Ollama/OpenAI-compatible responses with `choices[].message.tool_calls` work.
- Streaming tool-call deltas are aggregated before execution.

### Runtime PR 2: Workspace-Scoped Coding Tool Executor

Branch suggestion: `codex/workspace-coding-tool-executor`

Responsibilities:

- Implement `shell.exec` with argv input, workspace-scoped cwd resolution,
  timeout, output caps, cancellation, and environment allowlist.
- Document and enforce the expected `shell.exec` use cases: read/list/search,
  git inspection, diagnostics, builds, and tests.
- Implement `apply_patch` as a structured patch executor, not arbitrary shell
  text.
- Document and enforce that intentional file edits use `apply_patch`, not shell
  redirection, heredocs, or ad hoc file-write commands.
- Add path safety that rejects traversal and symlink escapes.
- Emit normalized runner events for command output and patch changes.

Acceptance criteria:

- `shell.exec` can run read/search/list/test commands inside the workspace.
- Commands cannot escape the workspace via cwd, symlink, or absolute path
  tricks.
- Output truncation and timeout behavior are deterministic and tested.
- `apply_patch` rejects malformed patches and paths outside the workspace.

### Runtime PR 3: Relay Protocol and Execution Placement

Branch suggestion: `codex/local-coding-relay-execution`

Responsibilities:

- Decide whether tool execution is runtime-managed, helper-managed, or both.
- If helper-managed, pass tool definitions and policy to the helper and receive
  progress/tool-result frames.
- If cloud/runtime-managed, send explicit tool execution requests to the helper
  and wait for `tool_call_result` frames.
- Normalize both modes to the same runner events for Platform.

Acceptance criteria:

- The dispatch protocol has versioned frame types for tool definitions,
  tool-call requests, tool execution requests, and tool results.
- Runtime can report helper capability mismatch before dispatching a run.
- A local coding smoke test exercises model -> tool -> model -> final answer.

### CLI/Helper PR 1: Workspace Registration and Policy

Branch suggestion: `codex/helper-workspace-tool-policy`

Responsibilities:

- Add CLI config for workspace root, workspace ID, helper token, model endpoint,
  allowed commands, environment allowlist, and default timeouts.
- Ensure config file permissions are restrictive.
- Register capabilities with Platform/Runtime: native tool loop support,
  filesystem access, shell access, patch support, and supported workspace roots.

Acceptance criteria:

- `register` or equivalent command writes a config that identifies the local
  workspace root for a specific workspace.
- Helper refuses filesystem tools when no workspace root is configured.
- Capability registration is visible from Platform settings/status.

### CLI/Helper PR 2: Local Tool Execution Service

Branch suggestion: `codex/helper-local-tool-execution`

Responsibilities:

- Execute `shell.exec` and `apply_patch` locally when Runtime delegates tool
  execution to the helper.
- Reuse the same schemas and result shape as Runtime.
- Stream command output events without leaking secrets.
- Support cancellation and per-tool timeouts.

Acceptance criteria:

- Helper can execute an end-to-end tool call from a relay frame.
- Helper returns structured success/failure payloads, not raw process errors.
- Path and command policy tests run in CI.

### CLI/Helper PR 3: Local Coding Smoke Harness

Branch suggestion: `codex/local-coding-smoke`

Responsibilities:

- Add a repeatable smoke command that starts or targets a local model endpoint,
  registers a workspace, asks the model to read/search/edit a fixture file, and
  verifies the final file state.
- Cover both native tool calling and prompt fallback where possible.
- Emit enough logs to diagnose whether failure was model selection, tool schema,
  provider parsing, execution policy, or persistence.
- Document a browser-driven manual smoke path where an agent logs in, opens the
  local-model Coding Agent, asks it to read a fixture file, asks it to create a
  trivial file, and verifies `shell.exec` handled the read while `apply_patch`
  handled the edit. See [local-model-coding-smoke.md](local-model-coding-smoke.md).

Acceptance criteria:

- One command can verify local model coding on a developer laptop.
- The smoke test proves the model received tool schemas and emitted a real tool
  call.
- The test fails clearly when the helper is unavailable.
- The manual browser smoke proves the normal chat UI can drive read and edit
  filesystem tool calls against a disposable workspace.

## Future Production Path

This document scopes the laptop/local-helper path. Production cloud execution is
a separate infrastructure project because it requires container scheduling,
workspace bootstrap, isolation, artifact retention, and cloud security policy.
See [production-container-tool-execution-scope.md](../active/production-container-tool-execution-scope.md)
for the proposed AWS/container architecture and PR plan.

## Parallelization Plan

Work can run in four lanes after Platform PR 1 defines the canonical tool
schemas:

| Lane | Can Start After | PRs |
|---|---|---|
| Platform contracts | Immediately | Platform PR 1, then PR 2 |
| Runtime model loop | Platform PR 1 schema draft | Runtime PR 1 |
| Execution boundary | Tool schema draft | Runtime PR 2 and CLI/Helper PR 1 |
| UX/observability | Platform PR 2 event contract draft | Platform PR 3 and PR 4 |

Runtime PR 3 and CLI/Helper PR 2 should converge on one execution placement
decision before implementation. The two viable modes are:

- Helper-managed loop: lower latency, local-only tool execution loop, Platform
  observes progress through Runtime.
- Runtime-managed loop: Runtime keeps the loop and asks helper to execute local
  tools; easier centralized policy/observability but more round trips.

Default recommendation: implement runtime-managed first if the current runtime
already has the tool-calling loop, then allow helper-managed mode later for
latency.

## Security and Policy Requirements

- Runtime context owns `workspace_id`, `user_id`, `agent_id`, and `session_id`.
- Tool arguments must never be trusted to select a different workspace.
- Every filesystem path must resolve inside the registered workspace root after
  symlink resolution.
- `shell.exec` should prefer argv over raw command strings.
- Environment variables should be allowlisted.
- Output should be capped, redacted where possible, and summarized for storage.
- Mutating commands and patches should support approval policy before execution.
- Tool failures should return structured tool-result content to the model unless
  the executor itself is unavailable.

## Open Questions

- Should the MVP route local coding through Runtime directly, through the helper,
  or support both behind a capability flag?
- Is `apply_patch` implemented in Runtime, helper, or shared as a small library
  to avoid divergent patch semantics?
- Which commands require approval by default: package installs, git writes,
  process management, network calls, file deletion?
- Should Platform persist complete command output, capped output, or only
  summaries with downloadable artifacts?
- How should multiple local machines registered to the same workspace be
  selected for a run?
- Should prompt-based tool fallback be allowed for coding tools by default, or
  only for explicitly trusted models?

## First PR Recommendation

Start with Platform PR 1 as a narrow schema/seed PR. It gives the runtime and
helper work a stable contract without enabling filesystem execution yet. The
runtime/helper execution PRs can then implement against the exact schemas the
model will receive.
