# Policy & Trust Dial — Scope

## Goal

The autonomous loop pillar (vision Pillar 4) demands that an agent
take irreversible actions on its own — merge a PR, deploy a build,
post a comment — but only within bounds the workspace has explicitly
authorized. Those bounds are the **trust dial**: a versioned,
workspace-scoped policy that governs when the agent must escalate to
a human, when it may proceed alone, and what enforcement happens on
the way.

The design is already specified in
[`docs/open-questions/oq-06-escalation-policy-schema.md`](../open-questions/oq-06-escalation-policy-schema.md).
This scope is the implementation plan — how OQ-06's contract lands in
code, how it's enforced, and how the user edits it.

The trust dial is the **foundation for the rest of Pillar 4**: the
self-review state machine (4.1), peer-review dispatch (4.2),
auto-merge gates (4.3), and attention queue (4.5) all read their
thresholds from this policy. Without it they have nowhere to look,
and there is no way for a user to say "be more cautious here, more
aggressive there."

Specifically:

1. **A Zod schema** in `contracts/escalation-policy.ts` formalizing the
   OQ-06 JSON shape. Every read from `gateway_config.body.escalation`
   parses through this schema; every write validates.
2. **An `escalation` table** (designed in OQ-08, built here) that
   records each escalation event with trigger kind, detail, state,
   and resolution. This is what Pillar 4.5's attention queue reads.
3. **The `escalate_to_human` tool** as a first-class agent capability,
   injected for every agent whose policy has `self_flagged.tool_enabled`.
4. **Four enforcement points** in the runtime (covered in the
   [companion runtime scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/policy-trust-dial-runtime-scope.md)):
   structural rule checks before any commit; resource cap checks at
   turn boundaries; gate-failure threshold tracking; self-flagged
   tool dispatch.
5. **A policy editor UI** in workspace settings — the trust dial
   itself, with sensible defaults and per-section editing.
6. **Validation-at-write** so a malformed policy can never land in
   the DB.
7. **Per-task cost overrides** so the planner can lower (never raise)
   the cost cap for a specific task.

## Current state

### What exists

- **`gateway_config` table** (harper-server migration
  `20260227140000_create_gateway_config_tables.sql`):
  ```sql
  scope_type text CHECK (scope_type IN ('workspace', 'agent', 'user')),
  scope_id text NOT NULL,
  config_json jsonb NOT NULL DEFAULT '{}',
  config_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  updated_by uuid NOT NULL REFERENCES "user"(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id)
  ```
  Plus `gateway_config_versions` (immutable history of every change,
  with `change_summary` and `created_by`) and `gateway_config_state`
  (last applied version per scope, with apply status).

  This is full versioning + audit infrastructure already in the
  database. Policy plugs into it as the consumer.

- **Tool grant precedent**
  ([`agent-tool-grant-data-model-scope.md`](./agent-tool-grant-data-model-scope.md)):
  the existing relational tables `tool_policy_template`,
  `tool_policy_template_tool`, `agent_tool_grant`. These are *what an
  agent is allowed to do at all*. The trust dial is the broader
  layer above: *what an agent may do alone vs what requires a human*.

- **Token-usage tracking** in
  `apps/api/src/repositories/learning-cost.ts:16-32` — per-broker-run
  aggregation of `input_tokens`, `output_tokens`, `total_tokens`.
  Analytics only today; the cost cap enforcement reads from here.

- **Retry infrastructure**: `broker_task.next_retry_at`,
  `execution-profile.ts` `retryable` field,
  `apps/api/src/repositories/logging.ts` records `retryable`
  classification. No max-retries enforcement yet.

- **Routing rules** in `routing_rule` table (separate from
  `gateway_config`). The split is intentional per OQ-03: hot-path
  individually-edited config gets relational tables; policy-as-a-unit
  goes in `gateway_config.body`.

### What's missing

- **No `EscalationPolicy` schema in `contracts/`**. Reads from
  `gateway_config.body.escalation` would be unvalidated `unknown`.
- **No `escalation` table.** Designed in OQ-08; not in the DB.
- **No `escalate_to_human` tool.** Specified in OQ-06; no
  implementation, no platform-side registration, no runtime dispatch.
- **No structural rule checker.** Nothing today inspects a diff for
  forbidden paths, dependency changes, schema migrations, or secret
  rotations.
- **No resource cap enforcement.** `max_turns` exists in env-level
  Elixir config but is not workspace-scoped or policy-driven; no
  `max_wallclock_minutes`, `max_cost_usd`, or `max_retries` in any
  enforcement path.
- **No gate-failure tracking** (counts how many auto-recovery
  attempts a gate failure got before escalating).
- **No policy editor UI.** Workspace settings
  (`apps/web/src/components/settings/WorkspaceSection.tsx`) shows
  only a "Memory & learning" toggle today; no policy tab.
- **No delivery channels.** OQ-06 specifies dashboard + email;
  neither has a notification surface today.

## Proposed model

### The policy schema (formalizing OQ-06)

New file `contracts/escalation-policy.ts`:

```typescript
import { z } from "zod";

export const StructuralRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("path_glob"), pattern: z.string().min(1) }),
  z.object({ kind: z.literal("dependency_change") }),
  z.object({ kind: z.literal("schema_migration") }),
  z.object({ kind: z.literal("secret_rotation") }),
]);

export const DeliveryChannelSchema = z.enum([
  "dashboard", "email", "slack",
]);

export const QuietHoursSchema = z.object({
  start: z.string().regex(/^\d{2}:\d{2}$/),  // "HH:MM"
  end:   z.string().regex(/^\d{2}:\d{2}$/),
  tz:    z.string().min(1),                  // IANA tz
});

export const EscalationPolicySchema = z.object({
  schema_version: z.literal("1"),
  escalation: z.object({
    structural: z.object({
      require_human_for: z.array(StructuralRuleSchema).default([]),
    }),
    self_flagged: z.object({
      tool_enabled: z.boolean(),
      guidance_prompt_id: z.string().optional(),
    }),
    resource: z.object({
      max_turns_per_task:   z.number().int().positive().optional(),
      max_wallclock_minutes: z.number().int().positive().optional(),
      max_cost_usd:         z.number().nonnegative().optional(),
      max_retries:          z.number().int().nonnegative().optional(),
    }),
    gate_failure: z.object({
      after_auto_recovery_attempts: z.number().int().nonnegative().default(1),
    }),
    delivery: z.object({
      channels: z.array(DeliveryChannelSchema).default(["dashboard"]),
      quiet_hours: QuietHoursSchema.optional(),
    }),
  }),
});

export type EscalationPolicy = z.infer<typeof EscalationPolicySchema>;

export const DEFAULT_POLICY: EscalationPolicy = {
  schema_version: "1",
  escalation: {
    structural: { require_human_for: [
      { kind: "schema_migration" },
      { kind: "secret_rotation" },
      { kind: "dependency_change" },
    ]},
    self_flagged: { tool_enabled: true },
    resource: {
      max_turns_per_task: 40,
      max_wallclock_minutes: 60,
      max_cost_usd: 5.00,
      max_retries: 3,
    },
    gate_failure: { after_auto_recovery_attempts: 1 },
    delivery: { channels: ["dashboard"] },
  },
};
```

`DEFAULT_POLICY` is what a new workspace inherits. It's conservative:
schema migrations, secret rotations, and dependency changes always
escalate; cost capped at $5/task; max 40 turns / 60 minutes.

### The escalation table

Harper-server migration adds:

```sql
CREATE TABLE escalation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agent(id),
  work_item_id uuid REFERENCES work_items(id),
  task_id uuid REFERENCES task(id),

  triggered_at timestamptz NOT NULL DEFAULT now(),
  trigger_kind text NOT NULL
    CHECK (trigger_kind IN ('structural', 'self_flagged', 'resource', 'gate_failure')),
  trigger_detail jsonb NOT NULL,    -- the specific rule that fired
  reason text NOT NULL,             -- human-readable summary

  state text NOT NULL DEFAULT 'open'
    CHECK (state IN ('open', 'in_progress', 'resolved')),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES "user"(id),
  resolution jsonb,                 -- the human's decision payload

  notified_at timestamptz,
  notification_channels jsonb,      -- which channels successfully delivered

  policy_version integer NOT NULL,  -- gateway_config.version at trigger time

  metadata jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX escalation_workspace_open
  ON escalation (workspace_id, triggered_at DESC) WHERE state = 'open';
CREATE INDEX escalation_work_item ON escalation (work_item_id);
CREATE INDEX escalation_agent ON escalation (agent_id);
```

Schema choices:

- **`trigger_kind` is one of the four OQ-06 categories.** The
  `trigger_detail` JSONB carries the specifics (which rule, which
  resource cap, which gate). This lets the dashboard render typed
  views per kind.
- **`state` is a 3-state machine** open → in_progress (a human
  claimed it) → resolved (decision recorded). Pillar 4.5 owns the
  dashboard transitions; this scope just creates the table and the
  open state.
- **`policy_version` captures the gateway_config version at trigger
  time.** If the user edits the policy mid-flight, the escalation
  still reflects the rule that fired.
- **No expiry / response deadline.** Escalations sit indefinitely
  until a human resolves them. The dashboard can display "open for
  N days" by computing from `triggered_at` if it wants an urgency
  cue, but there's no state transition or auto-action when an
  escalation goes stale. Adding expiry is purely additive later.

OQ-08's design is the source for this shape — implementing it here
unblocks both 4.6 (write side) and 4.5 (read side).

### Repositories and routes

Platform repositories:

- `apps/api/src/repositories/escalation-policy.ts`:
  - `getForWorkspace(workspaceId): Promise<EscalationPolicy>` —
    reads `gateway_config` where `scope_type='workspace'`,
    `scope_id=workspaceId`; parses through `EscalationPolicySchema`;
    falls back to `DEFAULT_POLICY` if no row exists.
  - `update(workspaceId, policy, updatedByUserId): Promise<EscalationPolicy>` —
    validates, computes hash, increments version, writes
    `gateway_config_versions` row via the existing trigger.
- `apps/api/src/repositories/escalations.ts`:
  - `create(payload): Promise<Escalation>` — written by the
    runtime (via REST) or by platform-side enforcers.
  - `list(workspaceId, filters): Promise<Escalation[]>` — for the
    dashboard.
  - `resolve(id, resolution, resolvedByUserId): Promise<Escalation>` —
    transitions state to resolved.

Platform routes:

- `GET    /api/workspaces/:workspaceId/policy` → current policy.
- `PUT    /api/workspaces/:workspaceId/policy` → validate + write
  + return new version.
- `GET    /api/workspaces/:workspaceId/policy/history` → versions list.
- `POST   /api/escalations` → create (called by runtime).
- `GET    /api/workspaces/:workspaceId/escalations` → list (filtered
  by state, agent, work_item).
- `PATCH  /api/escalations/:id` → resolve / claim.

### The `escalate_to_human` tool

Tool contract registered in `contracts/tools/` and exposed to every
agent whose policy has `self_flagged.tool_enabled: true`:

```typescript
// Tool name: "escalation.escalate_to_human"
const args = z.object({
  reason: z.string().min(1).max(2000),
  context: z.string().min(1).max(10_000),
  options: z.array(z.object({
    id: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
  })).max(8).optional(),
  urgency: z.enum(["low", "normal", "high"]).default("normal"),
});
```

Tool dispatch (runtime — see runtime scope):

1. Parse args; reject malformed.
2. POST `/api/escalations` with `trigger_kind: "self_flagged"`,
   `trigger_detail: { reason, context, options, urgency }`.
3. Transition the work item to a paused state (defers to 4.5's
   `requires_human_input` state machine; until 4.5 ships, the work
   item simply pauses on the runtime side and waits for a resolution
   webhook).
4. Return to the model a confirmation message + the escalation id.
5. The orchestrator stops processing this work item until the
   escalation resolves.

A `guidance_prompt_id` (when set in the policy) injects a versioned
prompt that tells the agent *when* to call this tool — so model
behavior is policy-tunable, not hardcoded into the system prompt.

### Per-task cost overrides

OQ-06 allows the planner to *lower* (never raise) the cost cap for a
specific task. Implementation as a **separate `task_policy_override`
table** (not a jsonb column on `task`) — typed columns, real CHECK
constraints, per project rule that "if application code needs to
query, validate, or rely on its fields for behavior, model those
fields as columns or related tables instead."

Table shape (harper-server migration M3):

```sql
CREATE TABLE public.task_policy_override (
  task_id uuid PRIMARY KEY REFERENCES public.task(id) ON DELETE CASCADE,
  max_cost_usd numeric(10,2) CHECK (max_cost_usd >= 0),
  -- future override columns added here as additive ALTER TABLE:
  --   max_wallclock_minutes_override int CHECK (max_wallclock_minutes_override > 0),
  --   max_retries_override int CHECK (max_retries_override >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public."user"(id)
);
```

- One-to-one with task via `PRIMARY KEY (task_id)`. Cascade on task
  delete.
- Sparse: only tasks with overrides have a row. No nullable column
  added to the hot `task` table.
- `max_cost_usd` is a typed `numeric(10,2)` with a CHECK. Invalid
  values can't land in the DB.
- Future overrides (turns, wallclock, retries) added as additive
  ALTER TABLE — visible in migration history.

Runtime behavior:

- Resource enforcer reads `task_policy_override` joined to the task.
- Cost cap applied is `min(override.max_cost_usd, policy.resource.max_cost_usd)`.
  Override only tightens. A row with `max_cost_usd = NULL` (or no
  row) means "no per-task override; use workspace policy."
- Same pattern for any future override columns: take the tighter of
  the two caps.

Set-once semantics: a trigger rejects UPDATEs that modify a non-NULL
override value (planner sets at task creation; agent can read but
cannot edit). See migrations scope M3 for the trigger.

Structural rules and other resource categories have **no per-task
override** — asymmetry is intentional and called out in OQ-06.

### Policy editor UI

New route: `/settings/policy` (rendered in
`apps/web/src/pages/settings/`).

Top-level sections matching the policy schema:

```
┌──── Trust dial — Workspace policy ──── version 7 ───────┐
│                                                          │
│ ┌─ Structural rules ─────────────────────────────────┐  │
│ │ Tasks that touch these always escalate to a human. │  │
│ │ ☑ Schema migrations                                 │  │
│ │ ☑ Dependency changes (package.json, etc.)           │  │
│ │ ☑ Secret rotations                                  │  │
│ │ Path patterns:                                       │  │
│ │   • infra/**                                        │  │
│ │   • **/migrations/**                                │  │
│ │   • [+ add pattern]                                 │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌─ Resource caps (per task) ─────────────────────────┐  │
│ │ Max turns           [40 ▼]                          │  │
│ │ Max wallclock       [60 min ▼]                      │  │
│ │ Max cost            [$5.00 ▼]                       │  │
│ │ Max retries         [3 ▼]                           │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌─ Self-flagged escalation ─────────────────────────┐  │
│ │ ☑ Agent may escalate to a human on its own         │  │
│ │ Guidance prompt: [escalation-guidance-v1 ▼]         │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌─ Gate failure ──────────────────────────────────────┐  │
│ │ Escalate after [1] auto-recovery attempt(s)         │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                          │
│ ┌─ Delivery ──────────────────────────────────────────┐  │
│ │ Channels:  ☑ Dashboard  ☐ Email (coming soon)       │  │
│ │ Quiet hours: ☐ enabled                              │  │
│ └─────────────────────────────────────────────────────┘  │
│                                                          │
│ [View version history]              [Save changes]      │
└──────────────────────────────────────────────────────────┘
```

Implementation notes:

- Each section is a small React component bound to its slice of the
  policy state.
- Save runs validation locally (`EscalationPolicySchema.safeParse`)
  before POSTing.
- "View version history" opens a side panel listing
  `gateway_config_versions` rows with diffs.
- Email delivery is greyed out / coming-soon until that phase ships.

The page lives alongside the existing
`WorkspaceSection` settings entries.

## DB migrations

Harper-server changes for this scope are enumerated in
[`harper-server/docs/vision-gaps-migrations-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/vision-gaps-migrations-scope.md)
(M1, M2, M3, plus optional hardening M9).

## Phased migration

### Phase 1 — Contracts + repository + DEFAULT_POLICY

- Add `contracts/escalation-policy.ts` with the schema and
  `DEFAULT_POLICY`.
- Add `apps/api/src/repositories/escalation-policy.ts` with
  `getForWorkspace` returning `DEFAULT_POLICY` when no row exists.
- No write path yet; no UI yet; no enforcement yet. The policy is
  *readable* but no consumer reads it.

### Phase 2 — Escalation table + repository + create route

- Harper-server migration: `escalation` table.
- `apps/api/src/repositories/escalations.ts` with `create` only.
- `POST /api/escalations` route, authenticated, validates payload
  against `trigger_kind` enum and ensures the agent belongs to the
  workspace.
- Schema sync runs;
  `apps/orchestrator/priv/generated/postgrest-schema.json` includes
  the new table.

### Phase 3 — Runtime structural rule enforcement

Companion runtime scope's Phase R-1 through R-3. See
[`policy-trust-dial-runtime-scope.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/policy-trust-dial-runtime-scope.md)
for path-glob matcher, dependency-change detector, schema-migration
detector, secret-rotation detector, all writing escalation rows.

### Phase 4 — Runtime resource cap enforcement

Companion runtime scope's Phase R-4. Turn-count, wallclock, retries,
and cost-cap checkpoints at turn boundaries. Cost cap reads from
`learning_cost` aggregations.

### Phase 5 — `escalate_to_human` tool

- Register tool in `contracts/tools/escalation.ts`.
- Add to default tool grants for every agent whose policy enables
  it.
- Runtime tool-dispatch path (covered in runtime scope's Phase R-5).
- Guidance prompt seed: create `prompt_template` row
  `escalation-guidance-v1`.

### Phase 6 — Gate-failure threshold tracking

- Add `gate_failure_count` to the work item's runtime state.
- Runtime increments on gate failure; checks against
  `after_auto_recovery_attempts`; escalates when threshold hit.
- (This is the simplest of the four enforcers; lives in the runtime
  scope's Phase R-6.)

### Phase 7 — Per-task cost overrides

- Migration: `task_policy_override` table (harper-server M3).
- Planner tool gains optional `max_cost_usd_override` arg; writes a
  `task_policy_override` row at task creation when set.
- Runtime cost enforcer joins `task_policy_override` and uses the
  tighter of `(override.max_cost_usd, policy.resource.max_cost_usd)`.

### Phase 8 — Policy editor UI

- New `/settings/policy` route in the web app.
- React components per section.
- Save flow + version-history side panel.
- Initial seed: when a workspace is created, write a
  `gateway_config` row with `DEFAULT_POLICY` instead of relying on
  the fallback. (Otherwise the first `PUT` would always create a
  v1 + v2 in quick succession.)

### Phase 9 — Dashboard delivery channel

- The "dashboard" delivery channel just means: the escalation row
  exists, is queryable, and surfaces in the attention queue.
- Phase 9 here is the API surface (`GET /api/workspaces/:id/escalations`).
  The full attention dashboard — queue page, per-kind resolution
  forms, claim/resolve, agent re-entry — is owned by
  [`attention-queue-scope.md`](./attention-queue-scope.md) (vision
  Pillar 4.5).

### Phase 10 — Email delivery (deferred)

Out of scope for this doc; tracked as a follow-on.

## Open questions

### OQ-PD-1 — Where does `guidance_prompt_id` resolve to?

OQ-06 specifies a `guidance_prompt_id` field referencing a versioned
prompt. There is no `prompt_template` table today.

**Tentative answer**: add a small `prompt_template` table here as
part of Phase 5 with `id`, `version`, `body`, `created_at`,
`created_by`. Seed `escalation-guidance-v1` as the canonical
escalation guidance prompt. Reuses
`gateway_config_versions`-style audit pattern.

### OQ-PD-2 — Slack delivery channel

OQ-06 lists `slack` alongside dashboard and email. Slack means
incoming webhook URL per workspace, integration auth, message
templates.

**Tentative answer**: scope it after email lands. Both are
non-trivial. Phase 9 (dashboard only) is the v1 success criterion;
email and slack are follow-ons.

### OQ-PD-3 — Should the schema use snake_case or camelCase in JSON?

The platform CLAUDE.md says API boundaries are camelCase, but the
OQ-06 doc uses snake_case in its JSON examples
(`max_turns_per_task`, `tool_enabled`). The DB column is jsonb, so
either works at the storage layer.

**Tentative answer**: snake_case in the stored JSON (matches OQ-06
verbatim); convert to camelCase at the API boundary in the Zod
schema. Same pattern as `*Row` schemas in the platform contracts
that mirror DB shapes.

### OQ-PD-4 — Cost cap currency assumption

`max_cost_usd` is USD. Workspaces with non-USD providers (e.g. some
EU enterprise contracts) would need conversion. Punt or address?

**Tentative answer**: USD only in v1, documented as such. Currency
conversion is a tax we don't need to pay yet — none of our current
providers price in non-USD by default.

### OQ-PD-5 — Policy edit-while-active behavior

If a task is mid-flight when the policy is updated, does the new
policy apply immediately or only to new tasks?

**Tentative answer**: new policy applies to new turn boundaries
within active tasks too. The `policy_version` captured on each
escalation row records which version actually fired. The
predictability cost (a task that started under loose limits could
hit a tightened cap mid-run) is worth the simplicity of one
in-memory cache invalidation. Tasks already-escalated remain on
their original deadline.

## Out of scope

- **Re-entry semantics after a human resolves an escalation** —
  OQ-08's territory; tracked under Pillar 4.5.
- **The polished attention-queue dashboard** — minimal queue view
  ships in Phase 9, but the dedicated "things waiting on me" page
  with filters, claim-this-one, snooze, etc. is Pillar 4.5.
- **Email and Slack delivery** — deferred (Phases 10+).
- **Per-agent policy** — `gateway_config.scope_type='agent'` exists
  as a reserved value, but policy is per-workspace in v1. Agent-level
  policy would let a "deploy" agent be more cautious than a "code
  cleanup" agent on the same workspace; defer until use case lands.
- **Cost prediction / budgeting before a turn runs.** v1 enforces
  *after the fact* by reading actual `learning_cost` totals. A turn
  that goes over budget mid-stream is stopped at the next turn
  boundary, not pre-empted mid-call.
- **Policy templates** (workspace presets like "high-trust" /
  "low-trust" you can pick from). The tool-grant scope has templates;
  trust dial v1 has one default and per-workspace edits. Presets
  are a UX follow-on.
- **Auto-merge gate logic itself** — Pillar 4.3. This scope provides
  the *policy* that auto-merge consults; 4.3 builds the consumer.

## Success criteria

1. `EscalationPolicySchema.parse(gateway_config.body)` round-trips
   for any valid policy and rejects malformed input at write time.
2. A new workspace inherits `DEFAULT_POLICY` on creation; visible
   in the editor with current version `1`.
3. An agent attempts to merge a PR that touches `infra/cors.tf`
   (matched by a `path_glob` rule). The orchestrator blocks the
   merge, writes an `escalation` row with
   `trigger_kind: "structural"`, `trigger_detail: { kind:
   "path_glob", pattern: "infra/**" }`, and the work item enters a
   paused state until the escalation resolves.
4. An agent's turn loop exceeds `max_turns_per_task=40`. The
   runtime writes an `escalation` row with
   `trigger_kind: "resource"`, `trigger_detail: { resource: "turns",
   value: 40, limit: 40 }`, and the work item pauses.
5. An agent calls `escalation.escalate_to_human` with a `reason`
   and three `options`. The tool returns an escalation id, an
   `escalation` row exists with `trigger_kind: "self_flagged"`,
   `trigger_detail` carries the args verbatim, and the orchestrator
   stops processing the work item.
6. A planner-created task with an accompanying `task_policy_override`
   row of `max_cost_usd = 1.00` is enforced at $1 (tighter than the
   policy's $5). The DB-level CHECK rejects negative values; the
   runtime cost enforcer applies `min(override, policy)` so a higher
   override never loosens the workspace cap.
7. The `/settings/policy` page loads the current policy, allows
   edits to every section, validates before POST, and stores a new
   version in `gateway_config_versions` on save.
8. `GET /api/workspaces/:workspaceId/escalations?state=open`
   returns the open queue, with one row per escalation event. The
   minimal queue view on the workspace home page renders it.

When all eight are true, Pillar 4.6 closes. Pillars 4.1, 4.3, and
4.5 can then proceed against a real policy + real escalation table.
