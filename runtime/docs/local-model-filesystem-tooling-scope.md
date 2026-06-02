# Local Model Filesystem Tooling Scope

This document scopes the runtime work required to let a locally hosted model act
like a coding agent that can inspect and edit a workspace. It mirrors the
Platform scoping document, but focuses on Runtime ownership: model tool-calling,
tool validation, local execution policy, relay protocol, normalized events, and
smoke coverage.

The core boundary is unchanged: Platform API should not become a
general-purpose filesystem or shell executor. Database tools may execute in
Platform, but coding tools must execute through Runtime and/or a local helper
with an explicit workspace root and policy.

## Goal

Allow a coding agent backed by a local OpenAI-compatible model to:

1. Receive `shell.exec` and `apply_patch` tool schemas from Platform dispatch.
2. Send provider-native tool specs to the local model when supported.
3. Parse model-emitted tool calls and loop with tool-result messages.
4. Execute or delegate `shell.exec` and `apply_patch` inside the selected
   workspace.
5. Emit normalized command, patch, tool-call, failure, timeout, and cancellation
   events back to Platform.

Target path:

```text
Platform resolves agent + tool definitions + workspace context
  -> Runtime starts local-model coding run
  -> Runtime/helper sends tools to the local model
  -> Model emits tool_calls
  -> Runtime/helper validates and executes shell.exec/apply_patch
  -> Runtime/helper appends tool results and continues the model loop
  -> Runtime emits normalized events and final response to Platform
```

## Non-Goals

- Do not add arbitrary shell execution to Platform API.
- Do not expose the local model endpoint or local filesystem over public HTTP.
- Do not add many granular filesystem tools for the MVP. Use `shell.exec` for
  read/inspect/run workflows and `apply_patch` for intentional edits.
- Do not trust model-supplied `workspace_id`, `user_id`, `agent_id`, or
  `session_id`. Runtime context is authoritative.
- Do not make production container execution part of the local-helper MVP.

## Current Runtime State

Runtime already has relevant building blocks, but each implementation PR should
verify what is merged to `main` before depending on branch-local code:

- OpenAI-compatible provider support exists and can normalize tool-call-shaped
  responses.
- Local relay dispatch and helper presence infrastructure exist.
- Runner events already include tool-call and patch-oriented event names.
- Some branches have explored a local-model coding runner, a shell executor, a
  patch executor, and smoke coverage.

Missing or incomplete pieces for the MVP:

- A merged local-model coding loop that sends tools, handles tool calls, appends
  tool results, and enforces iteration/repeated-call limits.
- A merged workspace-scoped `shell.exec` executor.
- A merged structured `apply_patch` executor.
- A final decision on whether local coding execution is Runtime-managed,
  helper-managed, or both behind a capability flag.
- End-to-end browser/manual smoke documentation that proves normal chat can
  drive read and edit tool calls.

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

Canonical slugs may be `shell.exec` and `apply_patch`, while provider-facing
function names may need to be sanitized, for example `shell_exec`. Runtime must
preserve a reverse mapping from provider name to canonical tool slug.

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

## Runtime PR Plan

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
- Return invalid tool names and malformed arguments as structured tool-result
  failures, not request-level crashes.
- Provide prompt-based fallback only when the provider/model cannot accept
  native tools.

Acceptance criteria:

- Unit tests cover single tool call, multiple calls, invalid tool name,
  malformed arguments, repeated calls, and max iterations.
- Ollama/OpenAI-compatible responses with `choices[].message.tool_calls` work.
- Streaming tool-call deltas are aggregated before execution.
- Tool failures can be appended back to the model as normal tool-result
  messages.

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

- Decide whether tool execution is Runtime-managed, helper-managed, or both.
- If helper-managed, pass tool definitions and policy to the helper and receive
  progress/tool-result frames.
- If Runtime-managed, receive tool-call requests, dispatch execution requests to
  the helper when filesystem access is not local to Runtime, and wait for
  `tool_call_result` frames.
- Normalize both modes to the same runner events for Platform.
- Report helper capability mismatch before dispatching a model run.

Acceptance criteria:

- The dispatch protocol has versioned frame types for tool definitions,
  tool-call requests, tool execution requests, and tool results.
- Runtime can reject missing/offline/incompatible helpers before asking the
  model to call tools.
- A local coding smoke test exercises model -> tool -> model -> final answer.

### Runtime PR 4: Local Coding Smoke Coverage

Branch suggestion: `codex/local-coding-tool-smoke`

Responsibilities:

- Add a repeatable runtime smoke flow that targets a local OpenAI-compatible
  endpoint and disposable workspace.
- Ask the model to read a fixture file through `shell.exec`.
- Ask the model to create or edit a trivial file through `apply_patch`.
- Verify normalized events include provider dispatch, tool-call start, command
  output, patch apply, tool completion/failure, and final response.
- Coordinate with Platform's browser manual smoke so an agent can log in, open
  the local-model Coding Agent, send read/edit prompts, and inspect visible
  tool-call evidence.

Acceptance criteria:

- One documented local flow proves Runtime receives schemas, model emits real
  tool calls, and filesystem tools execute against a disposable workspace.
- Smoke output makes it clear whether failure came from model selection, tool
  schema translation, provider parsing, helper availability, execution policy,
  or event persistence.
- Browser/manual smoke expectations match Runtime event names and result shapes.

## Cross-Repo Dependencies

Platform owns:

- Tool definitions and default coding-agent assignment.
- Passing authoritative workspace/user/session/agent context to Runtime.
- Tool-call persistence and browser rendering.
- Local coding settings and helper registration UX.

Local helper owns, if execution is helper-managed or delegated:

- Workspace root registration and config file permissions.
- On-machine `shell.exec` and `apply_patch` execution.
- Streaming command output, cancellation, and per-tool timeout enforcement.
- Capability registration so Runtime can reject incompatible helpers.

Runtime owns:

- Provider-specific tool serialization and tool-call parsing.
- Loop control, repeated-call protection, and tool-result message construction.
- Tool validation against the Platform-provided allowlist.
- Execution placement and relay frame normalization.
- Normalized event emission.

## Production Container Path

Production cloud execution is intentionally separate from the local-helper MVP.
The same model-facing tools should be reused:

- `shell.exec` remains the read/inspect/run tool.
- `apply_patch` remains the edit tool.

The execution target changes from a local helper to an isolated cloud container
with a checked-out workspace. That requires its own infrastructure design for
container scheduling, workspace bootstrap, resource limits, network policy,
secret injection, artifact retention, and cleanup. Runtime should keep the tool
schemas and normalized events compatible so a later container executor can plug
into the same loop.

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

- Should the MVP route local coding through Runtime directly, through the
  helper, or support both behind a capability flag?
- Is `apply_patch` implemented in Runtime, helper, or shared as a small library
  to avoid divergent patch semantics?
- Which commands require approval by default: package installs, git writes,
  process management, network calls, file deletion?
- Should prompt-based tool fallback be allowed for coding tools by default, or
  only for explicitly trusted models?
- How should Runtime select among multiple local machines registered to the
  same workspace?

## First PR Recommendation

Start with Runtime PR 1 if the provider loop is not merged, because it proves
that local models can receive schemas and return usable tool calls. If that loop
is already merged, start with Runtime PR 2 so `shell.exec` and `apply_patch`
have a concrete, workspace-scoped execution boundary.
