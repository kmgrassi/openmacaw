# Local Model Coding Runner Scope

This document scopes the runtime work required to let a local
OpenAI-compatible model act as a coding agent without using Codex app-server as
the tool runtime.

The goal is:

```text
local model endpoint
  -> Runtime-owned agent loop
  -> Runtime-owned coding tools
  -> assigned local workspace/worktree
```

The local model provides reasoning and tool-call selection. The runtime owns
tool definitions, approval policy, command execution, file mutation, workspace
boundaries, event logging, and cancellation.

## Non-Goals

- Do not call `codex app-server` for shell, patch, or file tools.
- Do not require OpenAI credits for the coding loop.
- Do not expose arbitrary host filesystem access as a feature.
- Do not add cloud multi-tenant isolation in this first scope. The first target
  is local execution with a clear path to later container/Fargate execution.

## Current Runtime State

Useful existing pieces:

- `Provider.OpenAICompatible` can call Ollama, vLLM, LM Studio, or other
  OpenAI-compatible endpoints.
- `Runner.ToolCallingLoop` already models multi-turn tool-call orchestration.
- `Runner.LocalRelay` and local relay protocol work provide a transport path
  for local helper execution.
- Codex app-server protocol schemas provide a useful reference shape:
  command execution, patch/file-change events, command-action classification,
  MCP tools, web search, view image, and request-user-input.
- `PathSafety` and existing workspace validation code provide a starting point
  for path boundary checks.

Missing pieces:

- No runtime-owned coding tool executor.
- No Codex-like coding tool schemas for shell execution, patch application, or
  command-action classification.
- No workspace-scoped shell execution with streaming stdout/stderr.
- No runtime-native approval policy for risky coding tools.
- No patch/file-change guardrail that rejects symlink/path escapes.
- No local model coding runner that combines provider calls with coding tools.

## Target Architecture

```text
Platform
  resolves execution profile
  runner_kind: local_model_coding
  provider: openai_compatible
  model/base_url credential reference
  workspace/tool policy
        |
        v
Runtime LocalModelCodingRunner
  calls Provider.OpenAICompatible
  presents Codex-like coding tool schemas
  validates tool calls
  executes tools inside workspace
  appends tool results to messages
  emits normalized run/tool/command events
        |
        v
Workspace / worktree
  shell commands
  git operations
  file reads/writes
  patch application
```

The same runner interface should later support a remote execution backend where
tool execution happens inside a per-agent container or task instead of directly
on the local host.

## Proposed Tool Surface

Mirror Codex's tool shape rather than introducing a broad set of granular
file/git tools. Codex primarily exposes command execution and patch/file-change
operations, then classifies commands for friendly display and approval.

| Tool | Purpose | Writes? | Notes |
|---|---|---:|---|
| `shell.exec` | Run an argv command in the workspace | Maybe | Enforce cwd, timeout, output cap, approval policy, sandbox policy |
| `apply_patch` | Apply a structured patch/file change | Yes | Prefer a dedicated patch path over shelling out for edits |

Command execution should include a best-effort `commandActions` classifier,
similar to Codex:

| Action | Meaning | Example commands |
|---|---|---|
| `read` | Reads a specific file | `cat`, `sed -n`, `head`, `tail` |
| `listFiles` | Lists directory contents | `ls`, `find` with bounded scope |
| `search` | Searches text or filenames | `rg`, `grep` |
| `unknown` | Anything else | installs, tests, builds, git commands, writes |

The classifier is not the security boundary. It is used for UI, logging, and
approval hints. The real boundary remains workspace validation, sandbox policy,
and approval policy.

Later tools:

- `web_search`
- `view_image`
- MCP/dynamic tools
- `browser.open`
- `browser.screenshot`
- `browser.click/type/evaluate`
- `port.forward`
- `process.start`
- `process.stop`

Browser/process tools should wait until the workspace/container execution model
is clearer, because they need lifecycle management and port ownership.

## Runtime PR Plan

| PR | Repository | Title | Database migration? | Scope | Acceptance |
|---|---|---|---|---|---|
| R1 | `parallel-agent-runtime` | Codex-like coding tool contract and event vocabulary | No | Add schemas/docs for `shell.exec`, `apply_patch`, command-action classification, normalized command/file-change events, and approval outcomes. | Tool specs are stable enough for platform DB seeding and provider prompt formatting. |
| R2 | `parallel-agent-runtime` | Workspace-scoped shell executor | No | Implement `shell.exec` with argv input, cwd enforcement, env allowlist, timeout, stdout/stderr streaming, output caps, cancellation, sandbox policy, and approval hooks. | Commands run only inside workspace; long-running commands can be cancelled; output streams into runtime events. |
| R3 | `parallel-agent-runtime` | Command action classifier | No | Add best-effort parsing for `read`, `listFiles`, `search`, and `unknown` actions. Use this for UI/event metadata and approval hints, not as the security boundary. | Common `cat`, `sed`, `ls`, `find`, and `rg` commands are classified; composed/unsafe commands fall back to `unknown`. |
| R4 | `parallel-agent-runtime` | Patch/file-change executor | No | Implement `apply_patch` with workspace path validation, symlink escape rejection, structured file-change events, and patch failure reporting. | Patches cannot write outside the workspace; patch begin/end events include changed file summaries. |
| R5 | `parallel-agent-runtime` | Local model coding runner loop | No | Add `Runner.LocalModelCoding` that calls `Provider.OpenAICompatible`, presents the Codex-like tool surface, executes tool calls, appends results, and stops on final output/limits. | Fake provider tests prove multi-turn shell/patch calls, final answer, unsupported tool rejection, and iteration limits. |
| R6 | `parallel-agent-runtime` | Approval policy and tool policy enforcement | No | Add runtime-native policy modes for `never`, `on-request`, and future stricter modes. Require approvals for risky shell and patch operations when policy demands it. | Approval-required events pause/fail cleanly in non-interactive runs and auto-approve only when configured. |
| R7 | `parallel-agent-runtime` | Local model coding smoke harness | No | Add a manual smoke flow for Ollama/Qwen or LM Studio that edits a disposable worktree through `apply_patch` and runs a simple test command through `shell.exec`. | One documented local smoke proves local model -> runtime tool call -> workspace mutation -> final response. |
| R8 | `parallel-agent-runtime` | Remote execution adapter seam | No | Refactor command/patch execution behind an executor behavior so the same tool surface can run locally now and in a container/Fargate task later. | Existing local tests pass through the executor behavior; no platform contract change required. |

## Runtime Security Requirements

- Resolve and canonicalize every file path before read/write.
- Reject absolute paths unless they are inside the approved workspace root.
- Reject symlink escapes.
- Run commands with explicit `cwd` and argv, not interpolated shell strings.
- Apply command timeouts and output byte limits.
- Keep secret-bearing env values out of logs and tool results.
- Treat shell command strings as high-risk operations under approval policy.
- Record every write-capable tool call with input metadata and result status.

## Runtime Event Requirements

The platform should not need to know whether a run came from Codex or the local
model coding runner. Emit equivalent normalized events where possible:

- `turn_started`
- `message.delta`
- `tool_call_started`
- `tool_call_completed`
- `tool_call_failed`
- `command_started`
- `command_output_delta`
- `command_completed`
- `patch_apply_begin`
- `patch_apply_end`
- `file_change_pending_approval`
- `approval_required`
- `turn_completed`
- `turn_failed`

## Testing Strategy

Unit tests:

- path normalization and symlink escape rejection;
- patch success and failure cases;
- shell timeout/cancel/output cap behavior;
- command-action classification for read/list/search/unknown commands;
- provider tool-call normalization across OpenAI-compatible response variants.

Integration tests:

- fake local model returns a sequence of tool calls and a final response;
- runner executes tools and appends tool results correctly;
- approval-required mode returns a typed interruption;
- unsupported tools are rejected without executing anything.

Manual smoke:

- create a disposable repo/worktree;
- start Ollama or LM Studio;
- ask the local model to make a small code change;
- verify diff, command logs, and final response.

## Open Questions

- Should the first runner live behind `runner_kind: local_model_coding` or be a
  mode of the existing `local_relay` runner?
- Which approval experience should be supported first for cloud-launched,
  non-interactive local runs?
- Should `apply_patch` use a native Elixir patch implementation, shell out to
  `git apply`, or support both?
- Should `shell.exec` accept only argv arrays, or also support a shell-string
  compatibility mode for model/provider ergonomics?
- Should browser tools be implemented in Runtime or in a separate local helper
  process with Playwright ownership?
- How much of the tool result history should be stored in Runtime versus
  Platform database tables?
