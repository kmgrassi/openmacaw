# Manager Agent Settings UI — Platform Scoping Document

## Goal

Add a per-agent settings panel in the platform UI for the manager
agent's runtime knobs:

1. **Cadence** (per-agent override; workspace value as backup default).
2. **Due-task state filter** (multi-select of work-item states).
3. **Due-task plan filter** (multi-select rendered by plan **name**;
   submitted as `planIds: string[]`).

`batch_limit` and `order_by` are explicitly **out of scope** — those
stay hardcoded at their current runtime defaults (25,
`next_poll_at ASC`).

## Prerequisites

This PR depends on two runtime PRs in `parallel-agent-runtime`:

- `feat/manager-per-agent-scheduler` — adds per-agent scheduler
  topology and per-agent `runners.manager.<agent_id>.min_cadence_ms`
  config key.
- `feat/manager-due-task-filter` — adds
  `runners.manager.<agent_id>.due_task_query` config key with `states`
  and `plan_ids` fields.

Both must be merged and deployed to the orchestrator before this UI
ships, otherwise the API will write config keys the runtime ignores.

## Storage shape (read/written by this UI via the API)

The platform writes into the existing workspace `gateway_config`
table. Workspace blob shape:

```jsonc
{
  "runners": {
    "manager": {
      // Workspace defaults (already used today for cadence)
      "min_cadence_ms": 60000,
      "due_task_query": {
        "states": ["running", "awaiting_review"],
        "plan_ids": null,
      },

      // Per-agent overrides
      "<agent_id>": {
        "min_cadence_ms": 30000,
        "due_task_query": {
          "states": ["running"],
          "plan_ids": ["uuid-of-plan-a", "uuid-of-plan-b"],
        },
      },
    },
  },
}
```

Setting any field to `null` (or omitting it) clears the per-agent
override and lets the workspace value take effect.

## Files to touch

### Backend (API)

| File                                                  | Change                                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `contracts/manager-agent.ts`                          | Add `ManagerAgentConfigRequestSchema` and `ManagerAgentConfigResponseSchema`.                                      |
| `apps/api/src/routes/manager-agent.ts`                | New `GET /api/manager-agent/agents/:agentId/config` and `PUT /api/manager-agent/agents/:agentId/config` endpoints. |
| `apps/api/src/services/manager-agent-config.ts` (new) | Read/write the per-agent subtree of `gateway_config.config_json` for a given workspace.                            |

### Frontend (web)

| File                                                       | Change                                                                                                                                               |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/api/manager-agent.ts`                        | Client functions `fetchManagerAgentConfig` and `updateManagerAgentConfig`.                                                                           |
| `apps/web/src/api/plans.ts` (new or extend existing)       | Client to list plans for the workspace (used to render plan filter by name).                                                                         |
| `apps/web/src/components/settings/ManagerAgentSection.tsx` | Add per-agent panel: agent picker → cadence + state filter + plan filter form. Existing workspace-level cadence stays as the "Backup default" value. |

## Specific changes

### 1. Contract additions

In `contracts/manager-agent.ts`:

```ts
const ManagerStateFilterSchema = z
  .array(
    z.enum([
      "pending",
      "running",
      "awaiting_review",
      "blocked",
      "done",
      "failed",
    ]),
  )
  .min(1);
// This is the manager scheduler due-task allowlist, not a DB enum.
// Keep it in sync with parallel-agent-runtime:
// apps/orchestrator/lib/symphony_elixir/manager/scheduler.ex -> @allowed_states.
// work_items.state is currently TEXT in Harper/Supabase generated types, so
// there is no generated enum to import from packages/supabase-schema.

export const ManagerAgentDueTaskQuerySchema = z.object({
  states: ManagerStateFilterSchema.nullable().optional(),
  planIds: z.array(z.string().uuid()).nullable().optional(),
});

export const ManagerAgentConfigRequestSchema = z.object({
  cadenceMs: z.number().int().positive().nullable().optional(),
  dueTaskQuery: ManagerAgentDueTaskQuerySchema.nullable().optional(),
});

export const ManagerAgentConfigResponseSchema = z.object({
  agentId: z.string().uuid(),
  cadenceMs: z.number().int().positive().nullable(),
  workspaceCadenceMs: z.number().int().positive().nullable(),
  dueTaskQuery: ManagerAgentDueTaskQuerySchema,
  workspaceDueTaskQuery: ManagerAgentDueTaskQuerySchema,
  effectiveCadenceMs: z.number().int().positive(),
  effectiveDueTaskQuery: ManagerAgentDueTaskQuerySchema,
});

export type ManagerAgentConfigRequest = z.infer<
  typeof ManagerAgentConfigRequestSchema
>;
export type ManagerAgentConfigResponse = z.infer<
  typeof ManagerAgentConfigResponseSchema
>;
```

`null` means "clear this override." `undefined` means "leave as-is."
The response always includes both the per-agent value and the
workspace value so the UI can show "Currently using: workspace default
(60s)" etc.

### 2. New API endpoints

In `apps/api/src/routes/manager-agent.ts`, add two routes:

```ts
app.get(
  "/api/manager-agent/agents/:agentId/config",
  apiRoute({
    requireAuth: true,
    async handler({ req, res }) {
      return res
        .status(200)
        .json(
          await getManagerAgentConfig(
            requireWorkspaceId(req),
            requireRouteParam(req, "agentId"),
          ),
        );
    },
  }),
);

app.put(
  "/api/manager-agent/agents/:agentId/config",
  apiRoute({
    requireAuth: true,
    bodySchema: ManagerAgentConfigRequestSchema,
    invalidBodyMessage: "Manager agent config is invalid",
    async handler({ req, res, body }) {
      return res
        .status(200)
        .json(
          await updateManagerAgentConfig(
            requireWorkspaceId(req),
            requireRouteParam(req, "agentId"),
            body,
          ),
        );
    },
  }),
);
```

Authorization mirrors the existing manager-agent routes.

### 3. Service layer

In `apps/api/src/services/manager-agent-config.ts` (new):

- Read `gateway_config.config_json` for the workspace.
- For `getManagerAgentConfig`: extract
  `runners.manager.<agentId>` and `runners.manager.<workspace
defaults>`; compute `effective*` by overlaying agent → workspace →
  runtime defaults. Validate the agent exists and belongs to the
  workspace.
- For `updateManagerAgentConfig`: deep-merge the incoming
  `cadenceMs` / `dueTaskQuery` into `runners.manager.<agentId>`. Treat
  `null` as "delete the key." Treat `undefined` as "leave as-is." Use
  optimistic concurrency (`config_hash` / `version`) like the existing
  manager activation flow does.
- Reject `planIds` whose UUIDs don't exist in the workspace's plans
  table — we want to fail loudly here rather than silently dropping in
  the runtime.

### 4. UI changes

`apps/web/src/components/settings/ManagerAgentSection.tsx`:

The page already has a workspace-level cadence. Restructure it as:

- **Top section: Workspace defaults** — keep the existing cadence
  preset select (already calls `POST /api/manager-agent/activate`).
  Label as "Backup default cadence — used when an agent has no
  override." Add (in this PR or follow-up): a workspace-level
  due-task-query form using the same fields as the per-agent panel.
- **Bottom section: Per-agent overrides** — new.

Per-agent panel layout:

```
[Agent picker: Select an agent ▾]    (lists workspace's manager agents)

When an agent is selected:

  Cadence
    ( ) Use workspace default (60s)
    (•) Override:  [60s ▾]   (same preset list as workspace)

  Due-task state filter
    Currently effective: [running, awaiting_review] (workspace default)
    Override: [☐ pending] [☑ running] [☑ awaiting_review] [☐ blocked]
              [☐ done] [☐ failed]
    [Clear override → use workspace default]

  Due-task plan filter
    Currently effective: All plans (no filter)
    Override:
      [Multi-select: Plan A, Plan B, Plan C ...]
        (rendered by plan.name; value submitted as plan.id)
    [Clear override → use workspace default]

  [Save]
```

Implementation notes:

- Plan list comes from the platform's plans endpoint. If one doesn't
  exist for read-only listing, add one (`GET /api/plans` returning
  `{ id, name }[]` for the workspace). Keep it minimal — we just need
  name + id.
- Use the existing `useState`-based form pattern from
  `ManagerAgentSection`. No new form library.
- "Clear override" sends `cadenceMs: null` or
  `dueTaskQuery: { states: null }` etc. UI shows the workspace value
  as the new "currently effective" value after save.
- After save, re-fetch the config and the manager status (existing
  `GET /api/runtime/manager-status`) so the operator sees the change
  reflected.

## Acceptance criteria

- [ ] Selecting an agent shows the current per-agent override and the
      workspace value side-by-side, with a clear "currently effective"
      indicator.
- [ ] Saving a cadence override updates
      `runners.manager.<agentId>.min_cadence_ms` and the new value is
      visible after refresh.
- [ ] Saving a state filter override updates
      `runners.manager.<agentId>.due_task_query.states`.
- [ ] Saving a plan filter override stores `planIds` in
      `runners.manager.<agentId>.due_task_query.plan_ids`.
- [ ] Plan filter UI renders plan names; submitted payload contains
      plan UUIDs.
- [ ] "Clear override" sends `null` and the API removes the key from
      the per-agent subtree.
- [ ] Saving with an invalid plan UUID (plan not in workspace)
      returns a 400 with a clear error.
- [ ] Workspace-level cadence still works for agents without an
      override.
- [ ] No agent without an explicit override changes behavior compared
      to today.

## Out of scope

- Batch-limit and order-by knobs — runtime keeps these hardcoded.
- Workspace-level due-task-query UI may stay out of this PR if it
  bloats the diff; a follow-up can add it. (Per-agent is what unlocks
  the actual user need; workspace defaults can be set out-of-band for
  now.)
- Schema migrations in `harper-server` — none required.

## Validation

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
```

Then a manual browser pass:

1. Start the runtime + platform per the runbook in
   `parallel-agent-runtime/CLAUDE.md`.
2. Open `/settings/manager`, pick a manager agent.
3. Set cadence override → confirm the manager scheduler picks up the
   new cadence (watch logs or `manager-status` panel).
4. Set state filter override → confirm work items in excluded states
   stop being processed by that agent (test by creating an
   `awaiting_review` item under a filter that only includes `running`
   and confirming it isn't picked up until the override is cleared).
5. Set plan filter override → confirm only items in the selected
   plans are processed.

## Related

- Runtime scoping doc:
  `parallel-agent-runtime/docs/manager-due-task-filter-scope.md`
- Runtime branch (cadence): `feat/manager-per-agent-scheduler`
- Runtime branch (filter): `feat/manager-due-task-filter`
