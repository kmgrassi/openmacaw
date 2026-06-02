# Agent Tool Data Model Overhaul - Platform Scope

## Goal

Move Platform to a single, normalized tool policy model owned by the database:

- Bundles are first-class rows.
- Bundle membership is stored in the database.
- Agent bundle selections are stored in a join table.
- Agent-specific includes/excludes are explicit override rows.
- Tool resolution is implemented once and shared by settings, agent start, and local chat.

This removes the confusing transitional model where:

- Bundle contents are hardcoded in multiple Platform services.
- `agent.tool_bundles` stores bundle slugs as an array.
- `agent_tool` is used both as an old assignment table and as new override storage.
- Default tools are still materialized into `agent_tool` by `ensureDefaultAgentToolsForAgent`.

## Proposed PR Sequence

The `PLAT-N` labels below are the planned platform PR numbers for this
rollout.

### PLAT-1: Contracts and generated schema adoption

Repository: `parallel-agent-platform`

Depends on:

- Harper-server HS-1 merged and generated schema published/available.

Purpose:

- Add/refresh Supabase generated types for the normalized schema.
- Update shared API contracts for bundle and override resources.
- Keep existing route behavior intact.

Contract shape:

```ts
type ToolBundle = {
  id: string;
  workspaceId: string | null;
  slug: string;
  name: string;
  description: string;
  systemManaged: boolean;
  enabled: boolean;
};

type ResolvedAgentTool = ToolDefinition & {
  enabledForAgent: boolean;
  source: "bundle" | "include_override" | "exclude_override";
  bundleIds: string[];
  bundleSlugs: string[];
};

type AgentToolOverride = {
  agentId: string;
  toolId: string;
  mode: "include" | "exclude";
  reason: string | null;
};
```

Verification:

- Schema contract tests prove Platform-consumed tables exist:
  - `tool_bundle`
  - `tool_bundle_tool`
  - `agent_tool_bundle`
  - `agent_tool_override`
- Typecheck passes.

### PLAT-2: Single normalized tool resolver

Repository: `parallel-agent-platform`

Depends on:

- PLAT-1
- Harper-server HS-2 available in dev/staging data.

Purpose:

- Replace duplicated resolution logic in `agent-tools.ts` and `local-chat-agent-tools.ts`.
- Read from normalized tables only.
- Remove the old `agent.tool_bundles` / `agent_tool` resolution path as part of
  the coordinated switch to normalized tables.

New service:

```ts
resolveAgentToolPolicy({
  agentId,
  workspaceId,
  supabase,
}): Promise<{
  bundles: ToolBundle[];
  tools: ResolvedAgentTool[];
}>
```

Resolution algorithm:

1. Load selected rows from `agent_tool_bundle`.
2. Load bundle definitions from `tool_bundle`.
3. Expand bundle tools through `tool_bundle_tool`.
4. Load overrides from `agent_tool_override`.
5. Remove excluded tools.
6. Add explicit include tools.
7. Filter disabled tools and workspace visibility.
8. Return source metadata for UI.

Code to retire or rewrite:

- Hardcoded bundle maps in `agent-tools.ts`.
- Hardcoded bundle maps in `local-chat-agent-tools.ts`.
- `tool-bundles.ts` as a source of bundle membership truth.
- Any fallback or dual-read path that preserves legacy tool assignment reads.

Verification:

- Unit tests for bundle-only resolution.
- Unit tests for include overrides.
- Unit tests for exclude overrides.
- Unit tests for local chat using the same resolver.

### PLAT-3: Agent settings API and UI for normalized bundles

Repository: `parallel-agent-platform`

PR number: 3

Depends on:

- PLAT-2

Purpose:

- Update settings endpoints and UI to manage bundle selections separately from overrides.
- Make the data model visible and understandable to users.

API route behavior:

- `GET /api/agents/:id/tools`
  - returns selected bundles, available bundles, available tools, and resolved tools.
- `PUT /api/agents/:id/tool-bundles`
  - replaces rows in `agent_tool_bundle`.
- `PUT /api/agents/:id/tool-overrides/:toolId`
  - upserts `agent_tool_override`.
- `DELETE /api/agents/:id/tool-overrides/:toolId`
  - removes an override.

UI behavior:

- Bundle section:
  - selected presets as checkboxes/toggles.
  - show system-managed bundle descriptions.
- Resolved tools section:
  - source column: bundle, included, excluded.
  - excluded tools remain visible but disabled.
- Custom tools section:
  - add/remove explicit include overrides.

Verification:

- Route tests for each endpoint.
- Component tests or browser smoke for settings save/reload.

### PLAT-4: Stop materializing default tools into `agent_tool`

Repository: `parallel-agent-platform`

Depends on:

- PLAT-2
- PLAT-3

Purpose:

- Remove the old assignment behavior.
- New agents should get bundle selections, not copied tool rows.

Code to remove or replace:

- `ensureDefaultAgentToolsForAgent`
- Calls from:
  - stored agent creation
  - credential/routing setup
  - start/readiness flows

Replacement:

```ts
ensureDefaultAgentToolBundlesForAgent({
  agentId,
  workspaceId,
  agentType,
  runnerKind,
  localModelCodingEnabled,
});
```

Default bundle assignment:

- planning agent -> `planner`
- manager agent -> `manager`
- regular coding agent -> `coding`
- local model coding agent -> `local_model_coding`

Verification:

- Creating agents no longer inserts `agent_tool` rows.
- Creating agents inserts expected `agent_tool_bundle` rows.
- Existing override behavior still works.

### PLAT-5 / Platform PR #5: Legacy cleanup after Harper-server HS-3

Repository: `parallel-agent-platform`

Depends on:

- Harper-server HS-3

Purpose:

- Remove all compatibility code for:
  - `agent.tool_bundles`
  - `agent_tool`
  - `agent_tool.included`
- Remove old tests that assert assignment-table behavior.
- Rename public API concepts from "agent tools" to "tool policy" where appropriate.

Verification:

- `rg "agent\\.tool_bundles|agent_tool|included"` has no policy-path references.
- API typecheck passes.
- Local model coding flow can read files through resolved local tools.

## Cross-Repo Dependency Order

1. HS-1: Add normalized schema and seed system bundles.
2. PLAT-1: Adopt schema/contracts.
3. HS-2: Backfill existing agents.
4. PLAT-2: Shared resolver.
5. PLAT-3: Settings API/UI.
6. PLAT-4: Stop writing legacy assignments.
7. HS-3: Drop or quarantine old schema.
8. PLAT-5: Remove compatibility.

## Open Questions

- Should custom workspace bundles be editable in the first release?
- Should `local_model_coding` be a bundle, or should local coding be represented as selected `repo_read` and `repo_write` bundles plus runner eligibility checks?
- Should excluded tools be shown in local-chat debug output for observability, even though they are not sent to the model?
- Should bundle changes be audited in a dedicated audit table?
