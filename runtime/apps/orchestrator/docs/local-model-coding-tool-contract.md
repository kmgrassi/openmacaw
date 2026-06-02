# Local Model Coding Tool Contract

This document defines the first stable Runtime-owned coding tool contract for
local OpenAI-compatible coding agents. The matching machine-readable contract is
[`local-model-coding-tool-contract.schema.json`](local-model-coding-tool-contract.schema.json).

The contract is intentionally small for R1:

- `shell.exec` runs one argv command in an approved workspace.
- `apply_patch` applies one structured patch in an approved workspace.
- command actions classify shell commands for display, logging, and approval
  hints.
- normalized events describe tool, command, patch, file-change, approval, and
  turn outcomes.

This PR only freezes the contract. Execution, approval decisions, cancellation,
and path enforcement are implemented by later PRs.

## Tool Specs

Runtime exposes tools to model providers through the existing `ToolSpec`
translation layer. Tool names use the dotted runtime tool vocabulary already
accepted by provider translation.

### `shell.exec`

Runs a command with explicit argv semantics. Implementations must not interpret
the command through a shell unless a later policy explicitly introduces that
mode.

Required input:

- `argv`: non-empty argv array. The first item is the executable.

Optional input:

- `cwd`: workspace-relative directory. Missing means workspace root.
- `timeout_ms`: command timeout budget.
- `env`: non-secret environment overrides allowed by policy.
- `approval_policy`: requested policy mode, one of `never`, `on-request`, or
  `on-failure`.
- `sandbox_policy`: requested sandbox mode, one of `workspace_write`,
  `workspace_read`, or `read_only`.
- `output_limit_bytes`: maximum captured stdout plus stderr bytes.

Result shape:

- `exit_status`: integer status when the process exits.
- `signal`: signal name when terminated by signal.
- `stdout`, `stderr`: capped command output.
- `timed_out`: boolean timeout marker.
- `output_truncated`: boolean output cap marker.
- `duration_ms`: elapsed wall time.
- `command_action`: best-effort classifier result.

### `apply_patch`

Applies a structured patch to files under the approved workspace root.

Required input:

- `patch`: patch document using the Runtime patch format.

Optional input:

- `cwd`: workspace-relative directory for patch path resolution.
- `approval_policy`: requested policy mode.

Result shape:

- `status`: `applied`, `rejected`, or `approval_required`.
- `changed_files`: file summaries with path, operation, and byte counts when
  known.
- `message`: safe human-readable detail.

## Command Actions

Command actions are not a security boundary. They are metadata for UI,
structured logs, approval hints, and later review surfaces.

Supported action values:

- `read`: reads a specific file, for example `cat README.md` or
  `sed -n 1,80p lib/app.ex`.
- `listFiles`: lists files or directories, for example `ls` or bounded `find`.
- `search`: searches filenames or text, for example `rg query`.
- `unknown`: anything else, including composed commands, writes, installs,
  builds, tests, and git mutations.

Every classifier result includes:

- `action`: one of the supported values.
- `confidence`: `low`, `medium`, or `high`.
- `reason`: short safe explanation.

## Approval Outcomes

Approval decisions use a shared vocabulary so platform and Runtime can display
the same states before execution exists:

- `approved`
- `denied`
- `not_required`
- `requires_interaction`
- `unavailable`

Non-interactive runs must not silently approve operations that policy marks as
interactive. Later execution PRs should emit `approval_required` and stop or
pause cleanly.

## Normalized Events

The local model coding runner should emit equivalent event names to other
runtime runners where possible:

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

Each event has:

- `type`: event name.
- `run_id` or `session_id`: run correlation.
- `tool_call_id`: present for tool-scoped events.
- `ts`: runtime timestamp in milliseconds when available.
- `metadata`: safe structured metadata only.

Events must not include raw tokens, bearer credentials, or secret-bearing
environment values.
