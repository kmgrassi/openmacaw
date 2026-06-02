# Default Agents and Credential Onboarding Plan

## Goal

On authenticated login, every user should have a default planning agent and a default coding agent in their first workspace. If either default is missing, the platform API should create or claim the needed agent and persist the user/workspace/role assignment.

The UI should then guide the user through adding model API keys. A single API key can be applied to one or both default agents, with both checked by default. Onboarding should nudge users to configure both agents, but it should not block access if only one is configured.

## Schema Dependency

This plan depends on the Harper Server migration in:

- `harper-server` PR: `Add default agent assignment table`
- table: `public.agent_default_assignment`

Expected shape:

- `workspace_id`
- `user_id`
- `agent_id`
- `role`: `planning` or `coding`
- `provisioning_source`
- uniqueness on `(workspace_id, user_id, role)`

The platform should treat default identity as a relationship:

```text
user + workspace + role -> agent
```

Default identity should not be stored on `agent.slug`, and should not use `agent_versions`.

## Backend Scope

### Auth State Bootstrap

`GET /api/auth/state` should become the bootstrap point for default agents.

Flow:

1. Verify Supabase access token.
2. Resolve the current user id.
3. Load the user's workspaces.
4. Choose the first/default workspace.
5. Ensure a default planning assignment exists.
6. Ensure a default coding assignment exists.
7. Return auth state with default-agent setup status.

The bootstrap must be idempotent. Repeated calls should not create duplicate agents or duplicate assignments.

### Workspace Selection

For this phase, defaults are created in the user's first workspace.

Selection order:

1. Earliest workspace membership by `workspace_members.created_at`.
2. If no membership exists, create a personal/default workspace and owner membership.

This mirrors the existing setup behavior and keeps the first implementation conservative.

### Default Agent Resolution

For each role, `planning` and `coding`:

1. Query `agent_default_assignment` by `(workspace_id, user_id, role)`.
2. If found and the agent still exists, reuse it.
3. If missing, try to claim an existing matching agent:
   - same `workspace_id`
   - same `created_by_user_id`
   - same `type`
   - active status preferred
4. If no matching agent exists, create one.
5. Insert the assignment row.

Suggested default names:

- `Planning Agent`
- `Coding Agent`

Suggested created agent fields:

```ts
{
  workspace_id,
  created_by_user_id: userId,
  name: "Planning Agent" | "Coding Agent",
  type: "planning" | "coding",
  status: "active",
  model_settings: {},
  tool_policy: role === "planning" ? planningToolPolicyDefaults() : {}
}
```

### Gateway Config Defaults

Default agents can be created before credentials are configured.

Create gateway configs either:

- immediately with empty `runners`, or
- when credentials/model are saved.

Recommended first version: create gateway config when credentials/model are saved. That keeps unconfigured agents from looking launchable.

Planning gateway config after credential setup:

```ts
{
  tracker: { kind: "database" },
  workflow_template: { id: "planning-default" },
  runners: [{ kind: "codex", model, provider }],
  max_concurrent_agents: 1
}
```

Coding gateway config after credential setup:

```ts
{
  tracker: { kind: "database" },
  workflow_template: { id: "coding-default" },
  runners: [{ kind: "codex", model, provider }],
  max_concurrent_agents: 1
}
```

### Credential Application

API keys can be reused across agents.

Add an endpoint that applies one credential to selected agents:

```http
POST /api/default-agents/credentials
```

Proposed body:

```json
{
  "workspaceId": "uuid",
  "provider": "openai",
  "model": "openai/gpt-5.2",
  "label": "OpenAI API Key",
  "keyName": "OPENAI_API_KEY",
  "secret": "sk-...",
  "agentIds": ["planning-agent-id", "coding-agent-id"]
}
```

Backend behavior:

1. Verify all selected agents belong to the authenticated user/workspace context.
2. Verify selected agents are assigned defaults for that user/workspace, or are otherwise allowed agent targets.
3. Save/update credentials for each selected agent.
4. Update each selected agent's `model_settings`.
5. Create or update each selected agent's `gateway_config`.
6. Insert `gateway_config_versions` rows.
7. Return refreshed auth/default-agent state.

The existing `credential` table supports reusable workspace/user credentials with `agent_id = null`, but the current runtime launch path also expects agent-scoped credentials in places. First implementation can duplicate the saved key into each selected agent. A later improvement can deduplicate by storing one workspace credential and linking/applying it by reference.

### Auth State Response Shape

Extend `SetupAuthStateSchema` with default-agent details.

Suggested addition:

```json
{
  "default_agents": {
    "planning": {
      "agent_id": "uuid",
      "configured": false,
      "missing": ["credential", "model", "gateway_config"]
    },
    "coding": {
      "agent_id": "uuid",
      "configured": true,
      "missing": []
    }
  },
  "onboarding": {
    "required": true,
    "blocking": false,
    "reasons": ["planning_missing_credentials"]
  }
}
```

`resolved_agent_id` should prefer:

1. configured coding default
2. configured planning default
3. coding default
4. planning default
5. existing fallback behavior

### Launch Behavior

Default provisioning should not automatically launch agents.

Launch should happen only when an agent has:

- a gateway config
- at least one runner
- model settings
- credentials needed by the selected provider

Missing launch prerequisites should return deterministic, user-actionable errors.

## Frontend Scope

### Auth Bootstrap

After Supabase login:

1. Call `/api/auth/state`.
2. Store default-agent ids and onboarding state.
3. If onboarding is required, route to the default-agent credential step.
4. If onboarding is not required, route to the selected/default dashboard.

Onboarding is non-blocking. The user should be able to continue if only one agent is configured.

### Credential Onboarding UI

The onboarding screen should show:

- Provider dropdown
- Model dropdown
- API key input
- Agent checklist

Provider dropdown:

1. OpenAI
2. Anthropic
3. all other supported providers alphabetically

Agent checklist:

- Planning Agent checked by default
- Coding Agent checked by default

If one agent is already configured, it can still be checked by default for key replacement, or shown as configured with an explicit checkbox. The safer first version is to keep both checked and make the action label clear.

Example action label:

```text
Save key for selected agents
```

### Nudge Behavior

If only one default agent is configured:

- allow continue to dashboard
- show a persistent but dismissible nudge in settings or dashboard
- keep the unconfigured agent visible with a setup action

Suggested copy:

```text
Your Coding Agent is ready. Add a key for your Planning Agent when you want planning assistance.
```

### Settings Integration

Settings should expose:

- both default agents
- provider/model status
- credential status
- action to add/replace key
- later: action to change default planning/coding agent

## Contracts

Update shared contracts for:

- default-agent auth-state payload
- credential application request/response
- provider/model selection payload if not already covered by model catalog contracts

The frontend should rely on contract parsing rather than ad hoc object checks.

## Runtime Scope

Runtime does not need to know about default assignments.

Runtime receives:

- agent id
- gateway config
- stored credentials

The platform API remains responsible for choosing which default agent id to launch.

## Testing Plan

Backend tests:

- new user with no workspace creates workspace, planning default, coding default, and assignments
- existing user with workspace and no defaults creates missing defaults
- existing matching planning/coding agents are claimed instead of duplicated
- repeated `/api/auth/state` is idempotent
- missing credentials make onboarding required but not blocking
- applying one credential to both agents creates/updates both agent configs
- applying one credential to one agent leaves the other unconfigured
- invalid agent ids in credential application are rejected

Frontend tests:

- login routes to onboarding when default agents need credentials
- both agents are checked by default
- provider dropdown pins OpenAI and Anthropic at top
- user can save one key for both agents
- user can save one key for only one agent
- user can continue with partial setup
- configured/unconfigured status renders correctly after reload

E2E/local validation:

- start runtime with `parallel-agent-runtime` `pnpm run start:local`
- start platform with `pnpm run dev`
- login with a fresh test user
- observe default agents created and onboarding shown
- save OpenAI or Anthropic key for both
- verify `/api/auth/state` reports both configured
- launch coding agent and verify runtime health

## Rollout Plan

1. Merge Harper Server migration.
2. Sync generated Supabase types into platform/runtime repos.
3. Add backend bootstrap logic behind normal auth-state path.
4. Add credential application endpoint.
5. Add frontend onboarding UI.
6. Add settings affordance for incomplete default agents.
7. Later: allow users to choose different defaults among shared workspace agents.

## Proposed PR Sequence

The implementation should land in small PRs with narrow blast radius. Each PR should be independently reviewable and keep runtime launch behavior stable unless that PR explicitly scopes a launch-path change.

### PR1: Sync Generated Supabase Types

Repository:

- `parallel-agent-platform`

Dependencies:

- Harper Server migration for `public.agent_default_assignment` merged and applied to the Supabase project.

Scope:

- Regenerate `supabase/generated/database.types.ts`.
- Confirm the generated types include `agent_default_assignment`.
- Add no product behavior.

Validation:

- `pnpm run supabase:schema:sync`
- TypeScript compile or the closest existing API/web typecheck command.
- Manual diff review to confirm only generated type updates changed.

Notes:

- If runtime code needs direct access to `agent_default_assignment`, do the equivalent generated-type sync in `parallel-agent-runtime` as a separate small PR. Current plan keeps assignment resolution in the platform API, so runtime sync should not be needed for the first implementation.

### PR2: Add Default-Agent Contracts

Repository:

- `parallel-agent-platform`

Status:

- [x] Done in `contracts/setup.ts` with focused contract coverage in `apps/api/src/contracts/setup-contracts.test.ts`.

Dependencies:

- PR1 merged.

Scope:

- Extend shared contracts for `/api/auth/state` to include:
  - default planning agent status
  - default coding agent status
  - non-blocking onboarding state
- Add request/response contracts for default-agent credential application.
- Add contract tests where the repo already has contract or API schema coverage.

Out of scope:

- Creating agents.
- Writing credentials.
- UI changes.

Validation:

- API contract tests.
- TypeScript compile or focused package checks.

### PR3: Backend Default-Agent Bootstrap - Done

Status: implemented in this branch.

Repository:

- `parallel-agent-platform`

Dependencies:

- PR1 and PR2 merged.

Scope:

- Add service logic for default-agent bootstrap.
- On `GET /api/auth/state`:
  - resolve first/default workspace
  - ensure default planning assignment
  - ensure default coding assignment
  - create missing default agents
  - claim existing matching agents when appropriate
  - return default-agent/onboarding contract fields
- Preserve idempotency for repeated auth-state calls.

Out of scope:

- Credential application endpoint.
- Frontend onboarding UI.
- Runtime launch changes.

Validation:

- Backend tests for:
  - new user/no workspace
  - existing workspace/no defaults
  - one missing default
  - existing matching agents claimed
  - repeated auth-state calls do not duplicate agents or assignments
  - invalid legacy `agent.type` rows do not break auth state
- Local authenticated `/api/auth/state` probe.

### PR4: Backend Reusable Credential Application

Repository:

- `parallel-agent-platform`

Status:

- Done in this worktree.

Dependencies:

- PR3 merged.

Scope:

- Add `POST /api/default-agents/credentials`.
- Validate selected agent ids against the authenticated user, workspace, and default assignments.
- Save one submitted credential to each selected agent for the first version.
- Update each selected agent's `model_settings`.
- Create or update each selected agent's `gateway_config`.
- Insert `gateway_config_versions` rows.
- Return refreshed auth/default-agent state.

Out of scope:

- First-class deduplicated workspace credential references.
- Frontend onboarding UI.
- Automatic runtime launch.

Validation:

- Backend tests for:
  - applying one key to both agents
  - applying one key to only planning
  - applying one key to only coding
  - rejecting agents outside the user's workspace/default assignment set
  - gateway config versioning on repeated saves
- Local authenticated API probe using dev Supabase credentials.

### PR5: Frontend Auth-State and Store Wiring

Status: Done in this worktree.

Repository:

- `parallel-agent-platform`

Dependencies:

- PR3 merged.

Scope:

- Parse new auth-state fields in frontend API client/store.
- Track default planning/coding agent ids.
- Track configured/missing status.
- Resolve initial route based on non-blocking onboarding status.

Out of scope:

- Full credential form.
- Settings management UI.

Validation:

- Frontend unit/store tests if available.
- Manual login against local API, confirming no route loop and state includes both defaults.

### PR6: Frontend Credential Onboarding Flow

Repository:

- `parallel-agent-platform`

Status:

- Not implemented on this branch. `origin/main` does not yet contain the PR4 backend credential endpoint, PR5 frontend auth-state wiring, or generated `agent_default_assignment` types that this PR depends on.

Dependencies:

- PR4 and PR5 merged.

Scope:

- Add onboarding screen for default-agent credentials.
- Provider dropdown shows:
  - OpenAI
  - Anthropic
  - all remaining providers alphabetically
- Model dropdown is provider-aware.
- API key input.
- Agent checklist:
  - Planning Agent checked by default
  - Coding Agent checked by default
- Submit to `POST /api/default-agents/credentials`.
- Allow continue with only one configured agent.
- Nudge the user when one default remains unconfigured.

Out of scope:

- Changing default assignments among shared workspace agents.
- Full settings redesign.

Validation:

- UI tests for default checkbox state and provider ordering.
- Manual local flow:
  - login
  - see onboarding
  - save one key for both agents
  - save one key for only one agent
  - continue with partial setup

### PR7: Settings and Dashboard Nudges

Repository:

- `parallel-agent-platform`

Dependencies:

- PR6 merged.

Scope:

- Surface default-agent status in settings/dashboard.
- Provide add/replace key action for each default agent.
- Add non-blocking nudge when planning or coding remains unconfigured.

Out of scope:

- Letting users choose a different default agent.

Validation:

- Manual local verification for configured and partially configured accounts.
- UI tests if the existing settings stack has coverage.

### PR8: Default Assignment Management

Status: Done.

Repository:

- `parallel-agent-platform`

Dependencies:

- Shared-workspace UX requirements finalized.
- PR7 merged.

Scope:

- Add API and UI for choosing a different default planning/coding agent in a workspace.
- Use `agent_default_assignment` as the source of truth.
- Support future shared workspace behavior where different users choose different defaults.

Out of scope:

- Initial onboarding.
- Credential creation.

Validation:

- Backend tests for per-user default changes in the same workspace.
- UI tests for assignment updates.

## Open Decisions

- Should gateway config be created at agent provisioning time with no runners, or deferred until credential setup?
- Should the credential application endpoint write duplicated agent-scoped credentials now, or introduce first-class reusable workspace credentials immediately?
- Should the user be able to skip onboarding permanently, or should the nudge remain until both defaults are configured?
- Should existing user-created matching agents be claimed automatically, or should defaults always be newly created when assignment rows are missing?
- Should default assignment changes be owner/admin-only, or can each workspace member choose their own defaults independently?
