# Manager Agent Default Login PR Plan

Scope document for getting a manager agent running by default when a user logs
in and the workspace has the credentials needed to run it.

This plan is intentionally browser-first. A user should be able to open the
platform UI, see that the workspace has a Manager Agent, attach or reuse a
model credential, and then watch the manager report status without using IEx,
manual SQL, or local command-line setup.

## Target Experience

1. User logs in.
2. Platform ensures the user's first workspace has Planning, Coding, and Manager
   agents.
3. Planning and Coding remain per-user defaults through
   `agent_default_assignment`.
4. Manager is workspace-scoped. It is created automatically, but it is not a
   per-user default assignment.
5. If a compatible credential already exists in the workspace, the Manager Agent
   can be activated automatically or with one confirmation click.
6. If no compatible credential exists, the UI shows a focused activation flow:
   provider, model, credential input/reuse, and cadence.
7. Runtime reports whether the manager scheduler is idle, running, or failing.

## Current State

Implemented pieces:

- Runtime has `SymphonyElixir.Runner.Manager`, manager tools, scheduler,
  supervisor, bootstrapper, and `GET /api/runtime/manager-status`.
- Platform has execution-profile contracts that include role `manager`.
- Platform has routing-rule and credential-reference APIs that can attach a
  credential reference to an agent.
- Platform login/auth bootstrap already ensures Planning and Coding agents.

Missing pieces:

- Platform stored-agent contracts only allow `coding`, `planning`, and
  `custom`; they do not allow `manager`.
- Login/auth bootstrap only calls `ensureDefaultAgent` for Planning and Coding.
- The Manager Agent is not created automatically in the implemented bootstrap
  path.
- There is no manager-specific platform API response in auth state.
- There is no UI route for Manager Agent setup/status.
- Platform does not proxy runtime `manager-status`.
- Runtime manager bootstrap needs to be verified end-to-end with config sourced
  from the database, not only from test sessions.

## Design Decisions

- Manager creation is automatic. Users configure or activate the manager; they
  do not create it manually.
- Manager is workspace-scoped, not a user default. Do not add manager rows to
  `agent_default_assignment`.
- Reuse existing `agent`, `routing_rule`, `routing_rule_match`,
  `credential`, `credential_alias`, and `gateway_config` tables.
- Prefer routing rules and credential references as the source of execution
  profile truth. Keep `gateway_config` compatibility where runtime still reads
  it.
- The first implementation should default to a conservative provider/model, but
  the manager must support provider/model swaps through the same execution
  profile path as other agents.
- UI should distinguish "manager exists but awaits credential" from "manager
  runtime is unhealthy".

## PR Plan

| PR | Repository | Title | Database migration? | Scope | Acceptance |
|---|---|---|---|---|---|
| PR1 | `parallel-agent-platform` | Add manager agent role to contracts and API normalization | No | Add `manager` to stored-agent and setup-facing agent type contracts where appropriate. Update API normalization so existing manager DB rows round-trip as `manager` instead of falling back to `coding`. Keep `DefaultAgentRole` limited to `planning | coding`. | API can list a DB `agent.type = 'manager'` row without coercing it to coding. Planning/coding default assignment behavior is unchanged. |
| PR2 | `parallel-agent-platform` | Ensure workspace manager on auth bootstrap | No | Add an idempotent `ensureWorkspaceManagerAgent` called from login/auth state after `ensureDefaultWorkspace`. It creates or claims one active manager agent per workspace, writes minimal model settings, and returns manager status in auth state. Do not write `agent_default_assignment`. | First login creates Planning, Coding, and Manager. Repeated login creates no duplicates. Existing manager rows are claimed. Auth state exposes `manager_agent.agent_id` and missing requirements. |
| PR3 | `parallel-agent-platform` | Manager execution profile and credential activation API | No | Add manager-aware credential attachment/reuse endpoints or extend existing credential-reference endpoints. Save `{runner_kind, provider, model, credential_ref}` to routing rules for the manager. Preserve existing workspace credential reuse. | With an existing workspace credential, API can attach it to the manager. With a pasted key, API stores the credential and attaches it. Execution profile resolves with no missing credential/model/runner. |
| PR4 | `parallel-agent-platform` | Manager runtime status proxy | No | Add authenticated platform API endpoint that proxies runtime `GET /api/runtime/manager-status?workspace_id=...`. Enforce workspace membership. Normalize statuses for UI: `not_created`, `idle_awaiting_credential`, `running`, `unhealthy`, `error`, `not_running`. | Browser can poll manager status through platform API. Missing runtime and runtime failures produce typed responses instead of generic 502s. |
| PR5 | `parallel-agent-platform` | Manager activation and settings UI | No | Add a Settings or onboarding surface for the Manager Agent. Show provider/model, cadence, credential reuse or API-key input, and live status. Include Anthropic and OpenAI at top of provider selection, followed by all supported providers. | User can activate a manager from the browser, reuse an existing credential, swap provider/model, and see status without manual setup. |
| PR6 | `parallel-agent-runtime` | Wire manager scheduler session from persisted config | No | Verify and, if needed, update manager bootstrap so a scheduler started from workspace config can invoke `Runner.Manager` with the resolved provider/model/credential configuration. Avoid test-only session wiring. | A manager scheduler started by runtime bootstrap can run a real manager turn when the workspace has a resolved execution profile. Missing credential results in idle status, not repeated failure logs. |
| PR7 | `parallel-agent-runtime` | Manager status and diagnostics hardening | No | Ensure `manager-status` reports scheduler existence, last tick, last error, credential/config missing state, and decision count. Add logs with workspace ID, manager agent ID, trace ID, and selected runner/provider. | Platform UI can explain why the manager is idle/unhealthy. Runtime logs identify credential, config, LLM, and tool-call failures without leaking secrets. |
| PR8 | `parallel-agent-platform` + `parallel-agent-runtime` | End-to-end manager smoke harness | No | Add a documented local smoke path and automated tests/fixtures: login bootstrap creates manager, attach credential, runtime scheduler sees due work item, manager runs one turn, status updates. | A developer can run one documented local flow and verify the Manager Agent is active from the browser. CI covers bootstrap idempotency and manager status states. |

## API Shape

### Auth State Additions

Add a workspace-scoped manager section next to existing defaults:

```ts
type SetupAuthState = {
  default_agents: {
    planning: DefaultAgentStatus;
    coding: DefaultAgentStatus;
  };
  manager_agent: {
    agent_id: string | null;
    configured: boolean;
    missing: Array<"agent" | "credential" | "model" | "gateway_config" | "runner">;
    execution_profile?: ExecutionProfileResolution;
  };
};
```

This keeps `default_agents` semantically clean. Planning/Coding are user
defaults; Manager is workspace infrastructure.

### Manager Activation

The UI needs one endpoint that can support both cases:

- attach an existing workspace credential by `credential_id` or alias;
- create a new credential from a pasted key, then attach it.

Candidate request:

```ts
type ManagerCredentialActivationRequest = {
  workspaceId: string;
  agentId: string;
  provider: CredentialProvider;
  model: string;
  runnerKind: "llm_tool_runner";
  credentialRef?:
    | { type: "credential_id"; value: string }
    | { type: "alias"; value: string };
  newCredential?: {
    apiKey: string;
    label?: string;
  };
  cadenceMs?: number;
};
```

The response should return updated auth/setup state plus current manager
runtime status if available.

### Runtime Status Proxy

Candidate response:

```ts
type ManagerRuntimeStatus = {
  workspaceId: string;
  agentId: string | null;
  status:
    | "not_created"
    | "idle_awaiting_credential"
    | "not_running"
    | "running"
    | "unhealthy"
    | "error";
  lastTickAt: string | null;
  lastDecisionCount: number | null;
  missing: string[];
  error: string | null;
};
```

## Database Review

No new table is required for the first pass.

Use existing tables:

- `agent`: manager identity, workspace ownership, type.
- `routing_rule` and `routing_rule_match`: manager execution profile and
  credential reference.
- `credential` and `credential_alias`: workspace credential storage/reuse.
- `gateway_config`: compatibility path for runtime config while manager runtime
  still reads `config_json.runners.manager`.
- `gateway_config_versions`: audit history for config edits.

Potential later migration:

- Add a DB check/enum update only if Harper schema currently rejects
  `agent.type = 'manager'`.
- Add manager-specific status/event persistence only if runtime status cannot be
  derived from scheduler state, `gateway_config_state`, and logs.

## Browser Flow

### Fresh User With No Credentials

1. Login calls `/api/auth/state`.
2. API ensures workspace, Planning Agent, Coding Agent, Manager Agent.
3. Dashboard loads with Manager Agent in `idle_awaiting_credential`.
4. User opens Manager Agent settings or sees activation banner.
5. User selects provider/model and pastes an API key.
6. API stores credential, writes routing rule, updates compatibility config.
7. Runtime picks up config and status changes to `running`.

### Existing Workspace Credential

1. Login ensures Manager Agent exists.
2. API sees compatible credential references in the workspace.
3. UI offers "Use existing OpenAI/Anthropic key".
4. User confirms.
5. API attaches credential reference to Manager Agent routing rule.
6. Runtime starts manager work on the next scheduler tick.

### Already Configured Manager

1. Login ensures Manager Agent exists and sees a configured execution profile.
2. No onboarding is shown.
3. Dashboard can show Manager Agent status in Settings and health surfaces.

## Test Plan

- Auth bootstrap creates exactly one manager per workspace.
- Auth bootstrap does not write `agent_default_assignment` for manager.
- Existing manager is claimed rather than duplicated.
- Manager agent survives contract parsing and UI list rendering as `manager`.
- Manager with no credential is not blocking onboarding, but shows activation
  nudge.
- Manager with existing credential resolves a complete execution profile.
- Platform status proxy handles runtime unavailable, scheduler missing, idle,
  running, and error states.
- Runtime scheduler started from persisted config can execute a real manager turn
  in a local smoke test.
- Provider/model swap updates future manager turns without recreating the
  manager agent.

## Open Implementation Questions

- Should manager auto-attach an existing compatible workspace credential, or
  should the UI require one confirmation click before first use?
- Which default provider/model should ship first while manager is still
  partially OpenAI-specific in runtime?
- Should cadence live only in `gateway_config.config_json.runners.manager`, or
  should routing/profile metadata also carry it?
- Should manager activity appear in the generic Agents settings list, a
  dedicated Workspace Manager page, or both?
