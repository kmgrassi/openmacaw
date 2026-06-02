# Manager Agent Default Login PR Plan

Runtime companion to the platform plan for getting a Manager Agent running by
default after user login when the workspace has appropriate credentials.

The platform owns browser UX, auth bootstrap, agent creation, credential
attachment, and API proxying. Runtime owns scheduler bootstrap, persisted
manager config resolution, manager turn execution, tool execution, diagnostics,
and status reporting.

Platform companion:
`parallel-agent-platform/docs/manager-agent-default-login-pr-plan.md`.

## Target Experience

1. User logs into the platform.
2. Platform ensures the user's workspace has Planning, Coding, and Manager
   agents.
3. Platform attaches or reuses a credential for the Manager Agent.
4. Runtime sees workspace manager config and starts a per-workspace manager
   scheduler.
5. If credential/config is complete, the scheduler runs manager turns against
   due `work_items`.
6. If credential/config is incomplete, the scheduler remains idle and reports a
   clear status instead of failing repeatedly.
7. The browser can see manager status through the platform API, backed by
   runtime `manager-status`.

## Current Runtime State

Implemented pieces:

- `SymphonyElixir.Runner.Manager` exists.
- `SymphonyElixir.Manager.Scheduler`, `Supervisor`, and `Bootstrapper` exist.
- `SymphonyElixir.Manager.Tools` defines and executes the manager tool surface:
  `read_artifact_state`, `read_recent_events`, `dispatch_runner`, `merge_pr`,
  `post_comment`, `escalate_to_human`, `snooze`, and `mark_done`.
- GitHub artifact-state adapter exists for code work items.
- Runtime exposes `GET /api/runtime/manager-status?workspace_id=...`.
- Workspace sweep can discover workspace-scoped `gateway_config` rows with
  `config_json.runners.manager`.

Known gaps:

- `Manager.Scheduler` currently defaults its session to
  `%{workspace_id: workspace_id}`.
- `Manager.run_batch/2` requires `session.runner`; without it, manager turns
  fail with `:manager_runner_not_configured`.
- `Runner.Manager` is currently OpenAI Responses-specific. It reads `api_key`
  from config or `OPENAI_API_KEY`.
- Automatic bootstrap needs to resolve persisted manager config, credentials,
  provider/model, and start a real manager runner session.
- Runtime status currently reports scheduler presence, but not enough
  credential/config/last-error detail for a browser setup flow.
- Existing implementation docs are partially stale because the manager runner
  and tools have since landed.

## Runtime Design Decisions

- Manager scheduler lifecycle is workspace-scoped. It should start for every
  workspace where platform has enabled manager config.
- Missing credential is an idle state, not a crash state.
- Runtime should not require local CLI-only setup for the manager path. All
  required config should be resolvable from persisted platform state and runtime
  environment.
- Manager execution should use the same execution-profile/routing direction as
  other agents. The initial implementation can preserve compatibility with
  `gateway_config.config_json.runners.manager` while platform/routing-rule
  integration catches up.
- Status responses should be product-facing enough for platform UI to explain
  what action is needed.
- Logs should identify workspace ID, manager agent ID when known, model/provider,
  trace/turn ID, and tool call failures without logging secrets.

## Cross-Repo PR Plan

| PR | Repository | Title | Database migration? | Scope | Runtime acceptance |
|---|---|---|---|---|---|
| PR1 | `parallel-agent-platform` | Add manager agent role to contracts and API normalization | No | Platform allows `agent.type = manager` to round-trip through API/UI contracts. | Runtime can assume manager agent rows are visible to platform instead of being coerced to coding. |
| PR2 | `parallel-agent-platform` | Ensure workspace manager on auth bootstrap | No | Login/auth state creates or claims one manager agent per workspace, without `agent_default_assignment`. | Workspace manager config exists before runtime scheduler needs to act. |
| PR3 | `parallel-agent-platform` | Manager execution profile and credential activation API | No | Platform attaches existing/new credentials to manager execution profile/routing config. | Runtime can resolve model/provider/credential for manager from persisted state. |
| PR4 | `parallel-agent-platform` | Manager runtime status proxy | No | Platform proxies runtime manager status with workspace membership checks and normalized UI statuses. | Runtime `manager-status` must return stable, typed states. |
| PR5 | `parallel-agent-platform` | Manager activation and settings UI | No | Browser UI activates manager, reuses credentials, swaps model/provider, and shows status. | Runtime should respond to config changes without manual restart where possible. |
| PR6 | `parallel-agent-runtime` | Wire manager scheduler session from persisted config | No | Resolve manager config for a workspace, start `Runner.Manager` session when config is complete, and pass `runner: SymphonyElixir.Runner.Manager` into scheduler session. Treat missing credential as idle. | A scheduler started by bootstrap can run a real manager turn from DB-backed config. Missing credentials do not produce repeated failures. |
| PR7 | `parallel-agent-runtime` | Manager status and diagnostics hardening | No | Expand `manager-status` and logs with idle/config/error states, last tick, last error, decision count, provider/model, and trace IDs. | Platform UI can distinguish not running, awaiting credential, running, unhealthy, and provider/tool failure. |
| PR8 | `parallel-agent-platform` + `parallel-agent-runtime` | End-to-end manager smoke harness | No | Add a documented local flow and test fixtures that prove login bootstrap, credential attach, scheduler run, manager turn, and status update. | Developer can verify manager activation from the browser without IEx/manual SQL. |

## Runtime PR6 Detail: Persisted Scheduler Wiring

The first runtime implementation PR should focus on one problem: a scheduler
started from workspace bootstrap needs enough session data to call
`Runner.Manager.run_turn/3`.

Suggested shape:

```elixir
workspace_id
  -> load manager agent/config for workspace
  -> resolve execution profile or compatibility gateway config
  -> resolve credential secret in runtime-controlled memory
  -> Runner.Manager.start_session(config, nil)
  -> scheduler session = Map.put(session, :runner, SymphonyElixir.Runner.Manager)
```

Idle cases should be explicit:

- no manager config: `{:idle, :manager_config_missing}`;
- manager config present but no credential reference:
  `{:idle, :manager_credential_missing}`;
- credential reference present but cannot resolve:
  `{:idle, :manager_credential_unresolved}`;
- provider unsupported by current manager runner:
  `{:idle, :manager_provider_unsupported}` or typed error, depending on whether
  platform allowed that provider.

The scheduler should keep ticking in these states and update status, but should
not call `Manager.run_batch/2` until a runnable session exists.

## Runtime PR7 Detail: Status Contract

Runtime should return enough information for platform to normalize into a UI
state.

Candidate response:

```json
{
  "workspace_id": "workspace-uuid",
  "agent_id": "manager-agent-uuid",
  "status": "idle_awaiting_credential",
  "missing": ["credential"],
  "provider": "openai",
  "model": "openai/gpt-5.2",
  "min_cadence_ms": 60000,
  "last_tick_at": null,
  "last_decision_count": 0,
  "last_error": null,
  "trace_id": null
}
```

Runtime statuses should cover:

- `not_running`: no scheduler exists for the workspace.
- `idle_awaiting_config`: scheduler exists but manager config is incomplete.
- `idle_awaiting_credential`: scheduler exists but no credential can be
  resolved.
- `running`: scheduler has a runnable manager session and last tick did not
  fail.
- `unhealthy`: scheduler exists but repeated ticks or health checks are failing.
- `error`: last tick failed with a typed runtime/provider/tool error.

## Manager Tool Surface

The current manager tool surface is sufficient for the default-login activation
path. The tools do not need to change before the browser setup flow can start
working.

Existing tools:

- `read_artifact_state(work_item_id)`
- `read_recent_events(work_item_id, since)`
- `dispatch_runner(work_item_id, runner_kind, intent, context)`
- `merge_pr(work_item_id)`
- `post_comment(work_item_id, body)`
- `escalate_to_human(work_item_id, ...)`
- `snooze(work_item_id, seconds)`
- `mark_done(work_item_id)`

Risks to verify during smoke testing:

- `dispatch_runner` must resolve the same route/config shape platform writes.
- `read_recent_events` requires the `event_log` table to exist in Harper.
- `escalate_to_human` requires the `escalation` table to exist in Harper.
- GitHub-backed tools need the expected artifact metadata on `work_items`.

## Local Browser Smoke Flow

The cross-repo smoke should prove this path without IEx:

1. Start platform API/web and runtime launcher locally.
2. Login in browser.
3. Platform auth state ensures Manager Agent for the workspace.
4. Open Manager Agent settings.
5. Attach or reuse a credential.
6. Create or select a due `work_item` with `next_poll_at <= now`.
7. Runtime scheduler runs a manager tick.
8. Browser status changes from idle to running or shows a typed actionable
   error.

## Documentation Cleanup

`apps/orchestrator/docs/manager-agent-pr-plan.md` should be updated after this
plan lands. It still describes several implemented files as missing. Keep that
historical implementation plan if useful, but add a clear "current status"
section or replace it with a remaining-work plan so future implementers do not
chase already-completed PRs.

## Test Plan

- Scheduler bootstrap with complete persisted manager config starts a runnable
  manager session.
- Scheduler bootstrap with missing credential reports idle and does not call the
  manager runner.
- Updating persisted credential/config changes future scheduler behavior without
  requiring manual local commands.
- `manager-status` returns typed states for not running, awaiting config,
  awaiting credential, running, unhealthy, and error.
- Manager turn emits traceable logs for LLM request failures and tool failures.
- End-to-end local smoke proves platform login/bootstrap to runtime scheduler
  execution.

## Open Questions

- Should runtime consume platform's resolved execution profile through an API,
  or independently resolve from Supabase/PostgREST using the same tables?
- Should the first runnable manager remain OpenAI-only until the generic
  `llm_tool_runner` adapter is complete, or should provider selection be
  blocked in platform until runtime supports it?
- How often should a scheduler refresh manager config/credentials after startup:
  every tick, on config version change, or through a runtime refresh event?
- Should manager status be tracked only in process state, or mirrored into a DB
  row for restart-safe status history?
