# Agent Configuration Error UX — Platform Scoping Document

## Problem

When an agent fails to start due to missing configuration, the user experience is opaque:

- The browser console logs `[gateway-context] runtime preparation failed: ['runtime_start_failed']`
- The UI shows a generic "config failure" error or a red error banner with an unhelpful message
- The user has no way to determine the root cause — missing API key? Wrong model? No routing rule? Missing gateway config?

The information needed to diagnose the problem **already exists** in the platform. The execution profile resolver (`apps/api/src/services/execution-profile-resolver.ts`) returns a `missing` array with specific requirements like `["credential", "runner", "model"]`. The diagnostic endpoint (`/api/diagnostic/agents/:id`) builds a full blocker list. But none of this reaches the user through the normal UI flow.

## Goal

Replace generic configuration failure errors with a **structured checklist** that tells the user exactly what is missing and links them to the right settings page to fix it.

## Current Flow (What Happens Today)

1. User navigates to `/dashboard/:agentId`
2. `Dashboard.tsx` calls `fetchSetup(agentId)` which hits `GET /api/setup?agentId=...`
3. The setup response includes `requirements: { configured: boolean, missing: string[] }`
4. `GatewayContext.tsx` calls `prepareRuntime(agentId)` which hits `POST /api/agents/:id/start`
5. `assertRuntimePrepareSupported()` in `runtime-prepare.ts` calls `resolveExecutionProfile()`
6. If `resolution.missing.length > 0`, it throws `ApiRouteError(422, "agent_runtime_unconfigured", ...)` with the full resolution in `details`
7. The launcher client receives a 422 with `{ error: { code, message, details: { missing, execution_profile } } }`
8. `GatewayContext.tsx` logs `runtime preparation failed: prepared.reasons` and sets `status: "error"`
9. The dashboard shows a generic red error banner

The structured data (`missing`, `execution_profile`) is present in the API response but the frontend discards it and only checks `ready_to_connect`.

## Proposed UX

When a user navigates to an agent's dashboard and it is not fully configured, instead of a generic error, show a **configuration status card** with a checklist:

```
Agent Configuration

[check] Agent created
[check] Model selected: openai/gpt-5.2
[x]     API key missing              [Add Credentials]
[x]     Runtime not configured       [Configure Runtime]
```

Each failed item has an **action button** that either:
- Navigates to the correct settings page (e.g., `/settings/agents/:agentId`)
- Shows an inline form (for credentials, using the existing `AgentCredentials` component)

## PR Plan

### PR1: Structured error response for agent start failures

**Files:**
- `apps/api/src/services/runtime-prepare.ts`
- `apps/api/src/services/setup/builders.ts`
- `contracts/setup.ts` (or new `contracts/agent-checklist.ts`)

**What changes:**

Instead of throwing a generic 422 when `resolution.missing.length > 0`, build a structured checklist response. The checklist maps each resolution step to a user-facing status:

```json
{
  "configured": false,
  "checklist": [
    { "step": "agent_exists", "status": "pass", "label": "Agent created" },
    { "step": "model_selected", "status": "pass", "label": "Model: openai/gpt-5.2" },
    { "step": "credential_configured", "status": "fail", "label": "API key required", "action": "add_credential", "actionUrl": "/settings/agents/{agentId}" },
    { "step": "routing_rule", "status": "pass", "label": "Routing rule matched" },
    { "step": "launcher_ready", "status": "fail", "label": "Gateway config missing", "action": "configure_runtime" }
  ]
}
```

**Implementation approach:**

Add a `buildConfigurationChecklist(resolution: ExecutionProfileResolution, agentId: string)` function in `apps/api/src/services/setup/builders.ts` that:

1. Takes the existing `ExecutionProfileResolution` (which already has `missing`, `profile`, `source`)
2. Maps each requirement to a checklist item with human-readable labels
3. For failed items, includes an `action` code and `actionUrl` the frontend can use

The `missing` array from `resolveExecutionProfile` already distinguishes: `agent`, `credential`, `model`, `runner`, `route`, `gateway_config`, `provider`. Each maps to a specific checklist step.

The 422 error response from `assertRuntimePrepareSupported` should include the checklist in its `details` field, alongside the existing `missing` and `execution_profile` data. This is backward-compatible since `details` is already an object.

**Key source locations:**
- `resolveExecutionProfile()` at `apps/api/src/services/execution-profile-resolver.ts:374` — returns `ExecutionProfileResolution` with `missing` array
- `buildResolution()` at line 321 — constructs the resolution with `missing` based on what is null/absent
- `assertRuntimePrepareSupported()` at `apps/api/src/services/runtime-prepare.ts:10` — throws 422 with `{ missing, execution_profile }` in details
- `buildRequirementStatusFromResolution()` at `apps/api/src/services/setup/builders.ts:290` — already maps resolution to `{ configured, missing }` for setup responses

### PR2: Include checklist in setup endpoint response

**Files:**
- `apps/api/src/services/setup.ts` (`assembleSetup` function)
- `apps/api/src/services/setup/builders.ts`
- `contracts/setup.ts` (types)

**What changes:**

The `GET /api/setup?agentId=...` endpoint already returns `requirements: { configured, missing }` via `buildRequirementStatusFromResolution()`. Extend this to also include the checklist:

```json
{
  "agent": { ... },
  "requirements": {
    "configured": false,
    "missing": ["credential"],
    "checklist": [
      { "step": "agent_exists", "status": "pass", "label": "Agent created" },
      ...
    ]
  }
}
```

This is the natural place for it because `Dashboard.tsx` already fetches setup on load (line 73-78) and uses `setup.requirements.configured` to determine behavior. The checklist is an additive field.

**Key source locations:**
- `assembleSetup()` at `apps/api/src/services/setup.ts:178` — calls `resolveExecutionProfile()` and passes result to `buildRequirementStatusFromResolution()`
- `Dashboard.tsx` line 83 — checks `setupResponse.requirements.configured`

### PR3: Agent configuration status card component

**Files:**
- `apps/web/src/components/dashboard/ConfigurationStatusCard.tsx` (new)
- `apps/web/src/routes/Dashboard.tsx`
- `apps/web/src/components/dashboard/RuntimeChatPanel.tsx`

**What changes:**

Create a `ConfigurationStatusCard` component that renders the checklist from the setup response. It replaces the generic error banner when `setup.requirements.configured === false`.

The card shows:
- A title: "Agent Configuration"
- Each checklist item as a row with a status icon (checkmark or X) and label
- For failed items, an action button that navigates to the appropriate settings page

The `Dashboard.tsx` component should render `ConfigurationStatusCard` instead of (or above) the `RuntimeChatPanel` when the agent is not configured. The existing error state (`error && <div className="...text-red-300">`) at line 222 should be enhanced to use the checklist when available.

**Key source locations:**
- `Dashboard.tsx` line 110-133 — builds `scope` and `target`, both null when not configured
- `Dashboard.tsx` line 222-225 — current generic error display
- `RuntimeChatPanel` — already receives `setup` prop, could check `setup.requirements.configured`

### PR4: Inline credential prompt on dashboard

**Files:**
- `apps/web/src/components/dashboard/ConfigurationStatusCard.tsx`
- `apps/web/src/components/dashboard/InlineCredentialForm.tsx` (new)

**What changes:**

When the missing item is `credential`, instead of just showing a link to settings, embed an inline credential form directly in the status card. This reuses the logic from the existing credential configuration flow (the `AgentCredentials` component pattern or `configureSetupAgentCredentials` API call).

The inline form collects:
- Provider (dropdown: openai, anthropic, etc.)
- API key (password input)
- Model (text input or dropdown)

On submit, it calls the existing `POST /api/setup/agent-credentials` endpoint, then refreshes the setup state. If successful, the checklist updates and the agent can start.

**Key source locations:**
- `configureSetupAgentCredentials()` at `apps/api/src/services/setup.ts:505` — existing endpoint for applying credentials to an agent
- The setup flow already handles credential application and gateway config creation

### PR5: Agent sidebar warning indicators

**Files:**
- `apps/web/src/components/AppShell.tsx` (or wherever the sidebar agent list is rendered)
- `apps/web/src/stores/auth.ts` (if agent status is cached in the auth store)

**What changes:**

In the sidebar agent list, show a warning icon next to agents that are not fully configured. On hover, show a tooltip with a summary of what is missing (e.g., "API key required, runtime not configured").

This requires the sidebar to know each agent's configuration status. The `listSetupAuthState` response already includes `default_agents` with `configured` and `missing` for each role. For non-default agents, the sidebar could use the setup endpoint or a lightweight status check.

**Key source locations:**
- `listSetupAuthState()` at `apps/api/src/services/setup.ts:227` — returns `default_agents` with status per role
- The auth store at `apps/web/src/stores/auth.ts` — caches resolved agent info

### Cross-Cutting: GatewayContext error handling

**Files:**
- `apps/web/src/context/GatewayContext.tsx`
- `apps/web/src/api/broker.ts` (`prepareRuntime` function)

**What changes:**

The `prepareRuntime` function in `broker.ts` currently returns `{ ready_to_connect, reasons }`. When the API returns a 422 with structured checklist data, `prepareRuntime` should parse and forward that data so `GatewayContext.tsx` can expose it.

Currently at `GatewayContext.tsx` line 201-203:
```typescript
if (!prepared.ready_to_connect) {
  setStatus("error");
  console.warn("[gateway-context] runtime preparation failed:", prepared.reasons);
```

This should be enhanced to store the checklist data in context state so the dashboard can render it. The `GatewayContextValue` type could add an optional `configurationChecklist` field.

**Key source locations:**
- `prepareRuntime()` at `apps/web/src/api/broker.ts:252` — calls `POST /api/agents/:id/start` and parses the response
- `GatewayProvider` at `GatewayContext.tsx:66` — the provider component that manages connection state

### Reusable Logic

The diagnostic endpoint (`/api/diagnostic/agents/:agentId`) at `apps/api/src/routes/agent-diagnostic.ts` already computes:
- Agent existence
- Routing rule evaluation with match details
- Execution profile resolution with missing requirements
- Local runtime connectivity
- Launcher health
- A `blockers` array with human-readable messages

The `buildBlockers()` function (line 43) and the diagnostic response structure should be reused by the checklist builder. The checklist is essentially a structured, action-oriented version of the diagnostic blockers.

## Sequencing

1. **PR1** first — adds the checklist builder function and includes it in 422 error responses (backend only, no UI changes)
2. **PR2** second — adds checklist to setup endpoint response (backend only, additive field)
3. **PR3** third — renders the checklist in the dashboard (frontend, depends on PR2)
4. **PR4** fourth — adds inline credential form (frontend, depends on PR3)
5. **PR5** fifth — sidebar indicators (frontend, can be done in parallel with PR4)
6. **Cross-cutting GatewayContext changes** can land with PR3 or as a separate PR

## Out of Scope

- Changing the execution profile resolver logic itself (it already works correctly)
- Modifying the launcher's config validation (that is the runtime repo's responsibility)
- Auto-fixing configuration issues (the UI guides the user, it does not auto-configure)
- Admin/team-level configuration views (this is per-agent, per-user)
