# Local Model Coding Runner Scope

This document scopes the platform work required to support coding agents powered
by a local OpenAI-compatible model without relying on Codex app-server for shell
or patch tools.

The companion Runtime document owns the runner loop and tool execution details.
Platform owns product configuration, database schema, API contracts, UI, routing,
and deployment expectations.

## Goal

Allow a user to route a coding agent to a local model such as Ollama/Qwen, LM
Studio, or vLLM, while the Parallel runtime executes coding tools in a controlled
workspace.

```text
User selects local model coding runner
  -> Platform resolves execution profile and tools
  -> Runtime calls local model endpoint
  -> Runtime executes shell and patch/file-change tools in workspace
  -> Platform stores messages, tool calls, run status, and UI events
```

## Non-Goals

- Do not depend on OpenAI/Codex credits for the local model coding path.
- Do not ask Platform API to run shell commands directly.
- Do not expose local model endpoints publicly.
- Do not build production multi-tenant container isolation in this first
  scoping phase.

## Repositories In Scope

| Repository | Responsibility |
|---|---|
| `parallel-agent-runtime` | Local model coding runner, provider loop, Codex-like shell/patch executor, command-action classification, approval policy, normalized events, smoke harness |
| `parallel-agent-platform` | Database migrations, execution profile/routing, tool definition records, API routes, UI, event persistence/display |
| Optional future `local-runtime-helper` | Only needed if local model/tool execution should happen through an installed helper instead of the runtime process directly |

No shared package repo is required for the first pass unless we choose to
extract tool schemas into a third package later.

## Current Platform State

Useful existing pieces:

- Execution profile contracts already separate runner/provider/model concerns.
- Routing rules and credential aliases exist.
- Tool definition tables exist for model-agnostic tools.
- Platform already proxies runtime/launcher status and agent runtime events.
- Local model first-class planning docs already cover registration and
  capability probing.

Missing or incomplete:

- No explicit coding runner kind for runtime-owned local model coding.
- No seeded coding tool definitions for shell execution and patch/file-change
  execution owned by this runner.
- No UI for selecting local model coding with clear capability and risk labels.
- No run/tool-call persistence shape for command output, command-action
  classification, and file changes at the level needed for local coding.
- No database representation for approval interruptions if they need to survive
  page reloads or async review.

## Execution Profile Shape

Candidate resolved profile:

```json
{
  "role": "coding",
  "runner_kind": "local_model_coding",
  "provider": "openai_compatible",
  "model": "qwen2.5-coder:latest",
  "credential_ref": "local-runtime:qwen",
  "tool_profile": "coding",
  "workspace_policy": {
    "sandbox": "workspace-write",
    "approval_policy": "on-request"
  },
  "capability_requirements": {
    "tool_calls": true,
    "json_mode": true
  }
}
```

The platform should resolve this profile and pass it to Runtime. Runtime owns
the actual tool execution. Platform should not require local model credentials
to be exposed to the browser.

## Codex-Like Tool Surface

Mirror Codex's practical tool shape instead of seeding many granular file and
git tools. Codex primarily exposes command execution and patch/file-change
operations, then classifies shell commands for UI and approval.

MVP tools:

- `shell.exec`
- `apply_patch`

MVP command action classifications:

- `read`
- `listFiles`
- `search`
- `unknown`

Command actions are metadata, not separate tools. For example, `rg`, `sed -n`,
and `ls` are still shell commands, but Platform can display them as search,
read, or list actions when Runtime classifies them.

Later tools/capabilities:

- `web_search`
- `view_image`
- MCP/dynamic tools
- browser/session tools

## Database Migration Plan

### Required Migration: Runner Kind and Tool Seeds

Adding `runner_kind = 'local_model_coding'` is not only a tool seed change. The
implementation PR must first update every schema-level and contract-level place
that constrains runner kinds.

At minimum:

- add a Supabase migration that updates any `routing_rule.runner_kind` check
  constraint or related enum/validation rule that rejects unknown runner kinds;
- regenerate Supabase types after the migration;
- update `contracts/runner-kinds.ts` with `local_model_coding`;
- decide whether `local_model_coding` belongs in `LOCAL_RUNNER_KINDS` or remains
  a distinct local-capable coding runner kind with separate credential/runtime
  validation;
- add resolver/API tests proving a routing rule can store and resolve
  `local_model_coding` without schema or contract drift.

After the runner kind itself is supported, add or update seed data for
runtime-owned coding tools. If the current `tool` table already supports these
columns, the tool portion can be seed-only:

- `slug`
- `name`
- `description`
- `parameters`
- `execution_kind`
- `runner_kind`
- `enabled`

Initial tool slugs:

- `shell.exec`
- `apply_patch`

Set each tool's `runner_kind = 'local_model_coding'` or the final chosen runner
identifier.

Do not seed `file.read`, `file.write`, `git.status`, or similar granular tools
for the MVP. Reading, searching, listing, testing, builds, package installs, and
git inspection should flow through `shell.exec` and be classified with
`commandActions` where possible.

### Likely Migration: Tool Call Persistence Hardening

Review the existing `tool_call` shape before adding columns. If it cannot
represent command/file events cleanly, add fields such as:

- `workspace_id`
- `agent_id`
- `run_id` or `session_thread_id`
- `tool_slug`
- `status`
- `command_actions jsonb`
- `arguments jsonb`
- `result jsonb`
- `started_at`
- `completed_at`
- `error_code`
- `approval_state`

This may be additive to the existing table or a new `agent_tool_call` table if
the current table is too message-specific.

### Optional Migration: Approval Requests

Only add this if approvals need to persist across page reloads, async operator
review, or non-interactive runs:

- `agent_approval_request`
  - `id`
  - `workspace_id`
  - `agent_id`
  - `run_id` / `session_thread_id`
  - `tool_call_id`
  - `kind`
  - `summary`
  - `risk_level`
  - `requested_action jsonb`
  - `status`
  - `created_at`
  - `resolved_at`
  - `resolved_by`

If the first implementation is synchronous and non-interactive, Runtime can
return a typed `approval_required` interruption without a new table.

### Not Required Initially

- A new `execution_profile` table.
- A new local machine registry table solely for this runner, unless we also
  decide to ship the local helper registration flow in the same phase.
- Run/session snapshot columns if existing metadata JSON can carry the resolved
  profile and capability snapshot.

## Platform PR Plan

| PR | Repository | Title | Database migration? | Scope | Acceptance |
|---|---|---|---|---|---|
| P1 | `parallel-agent-platform` | Local model coding runner contracts | Yes | Add/update TypeScript contracts for `runner_kind: local_model_coding`, workspace policy, capability requirements, `shell.exec`, `apply_patch`, command actions, normalized command/file-change events, and tool result payloads. Include the DB migration for runner-kind constraints and regenerate Supabase types before accepting/storing the new value. | Contracts compile and can represent a local model coding execution profile without Codex fields; routing rules can store/resolve `local_model_coding` without schema drift. |
| P2 | `parallel-agent-platform` | Seed runtime-owned coding tools | Yes | Add migration/seed for `shell.exec` and `apply_patch` tool definitions with `runner_kind` and JSON schemas aligned to Runtime R1. Do not seed granular file/git tools for the MVP. | Tools are queryable, assignable to coding agents, and disabled/enabled by workspace policy. |
| P3 | `parallel-agent-platform` | Execution profile resolver integration | Maybe | Let routing rules resolve coding agents to `local_model_coding` when local model capability requirements are met. Add fallback behavior for missing tool calls/offline local runtime. | Resolver chooses local model coding only when configured and compatible; otherwise returns a typed fallback or capability error. |
| P4 | `parallel-agent-platform` | Runtime dispatch/API contract updates | No | Ensure API routes pass the resolved profile, workspace policy, and tool assignments to Runtime. Normalize Runtime errors for UI/API consumers. | A coding run can be dispatched with `local_model_coding` profile in tests using a mocked Runtime response. |
| P5 | `parallel-agent-platform` | Tool call and command event persistence | Maybe | Persist local coding tool events, command action classifications, command output summaries, and patch/file-change summaries. Add migration only if existing message/tool tables cannot support the needed fields. | UI can reload a run and show tool calls, command status, classified actions, patch results, and errors without losing key context. |
| P6 | `parallel-agent-platform` | Local model coding setup UI | No | Add agent/settings UI to select local model coding, show capability requirements, choose approval policy, and explain workspace-write risk. | User can configure a coding agent for local model coding and see clear compatibility/risk states. |
| P7 | `parallel-agent-platform` | Approval request UI | Maybe | If approval persistence lands, add UI to review/approve/reject pending shell and patch/file-change actions. Otherwise display non-interactive approval-required failures clearly. | Approval-required runs are understandable and actionable in the UI. |
| P8 | `parallel-agent-platform` + `parallel-agent-runtime` | End-to-end local coding smoke | No | Add documented smoke flow and optional mocked API fixture proving Platform -> Runtime -> local model coding runner -> workspace mutation -> UI events. | A local Qwen/Ollama smoke can make a small change in a disposable repo and surface the diff/events in Platform. |

## Cross-Repo Sequencing

1. Runtime R1 and Platform P1 agree on tool schemas, runner kind, events, and
   error vocabulary.
2. Platform P1 lands runner-kind DB/contract support before any routing rule or
   resolver code stores `local_model_coding`.
3. Platform P2 seeds `shell.exec` and `apply_patch` while Runtime R2-R4
   implements the shell executor, command classifier, and patch executor.
4. Runtime R5 builds the runner loop against fake provider/tool tests.
5. Platform P3-P4 routes coding agents to the new runner.
6. Runtime R6 and Platform P7 decide whether approvals are synchronous or
   persisted.
7. Runtime R7 and Platform P8 prove the local smoke path.
8. Runtime R8 creates the later bridge to container/Fargate execution.

## UI Requirements

The UI should make these states explicit:

- local model endpoint configured / missing;
- model online / offline;
- tool-call capability supported / unsupported;
- workspace-write enabled / read-only;
- approval policy;
- local run currently executing;
- command running / completed / failed / timed out;
- command action classified as read / list / search / unknown;
- file changes pending / applied / rejected.

Avoid presenting OpenAI-compatible local models as equivalent to OpenAI models.
The UI should show capability-specific warnings instead of provider-name
warnings.

## API Requirements

Platform API should expose:

- resolved execution profile preview for an agent;
- available tools for the coding runner;
- local model capability probe status;
- dispatch/run status with normalized local coding events;
- typed error responses for:
  - `local_runtime_offline`
  - `model_not_found`
  - `capability_missing`
  - `approval_required`
  - `tool_execution_timeout`
  - `workspace_policy_violation`

## Open Questions

- Should the runner kind be `local_model_coding`, `local_runtime_coding`, or an
  extension of `local_relay`?
- Do we need persisted approval requests in the first PR set, or is a typed
  interruption enough?
- Should `shell.exec` accept only argv arrays, or also support a shell-string
  compatibility mode for model/provider ergonomics?
- Should tool definitions be globally seeded or workspace-seeded?
- Should Platform assign shell/patch tools by agent, by runner kind, or by tool
  profile?
- Should browser tools be in the same runner/tool profile or a separate
  browser-capable profile?
