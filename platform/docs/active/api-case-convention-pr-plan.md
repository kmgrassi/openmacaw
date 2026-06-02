# API Case Convention PR Plan

This plan rolls out the layered field-naming convention documented in
[CLAUDE.md](../../CLAUDE.md#field-naming-conventions-case-style):

- **DB layer** (Postgres / Supabase rows): `snake_case` (already true; do not
  touch).
- **API boundary** (HTTP request/response bodies, query params, WS payloads):
  `camelCase`.
- **Conversion happens once**, in repository / route-handler code. No
  conversion in transport helpers, web code, or test fixtures.

Today the contracts are mixed: some request/response Zod schemas mirror the
DB row shape verbatim (`workspace_id`, `created_at`, ...), and some already
use `camelCase`. This plan turns every API-boundary contract into camelCase
and updates the consumers that read those fields.

## Principles

1. **No backwards-compat shims.** Per [CLAUDE.md → No Backwards Compatibility
   Shims](../../CLAUDE.md#no-backwards-compatibility-shims), we do not add
   "also accept the old form" logic, transport-layer key rewriters, or
   `camelcase-keys` middleware. Each PR changes the schema, the route, and
   every consumer in lockstep.
2. **DB rows stay snake_case.** Repositories / services read snake_case from
   Supabase, and convert to camelCase before returning to route handlers.
   Schemas that intentionally mirror a DB row shape stay snake_case and get
   a `Row` suffix in their name (`StoredAgentRowSchema`, `BrokerRunRowSchema`,
   ...).
3. **Upstream services we don't control** (Elixir launcher, worker bridge)
   emit snake_case. Their response schemas in `contracts/launcher.ts` and
   `contracts/worker-bridge.ts` are *internal* parsing schemas — rename them
   to `*RowSchema` and add a thin mapping in the service layer that returns
   camelCase to our own routes. The external wire stays as-is.
4. **Tests update with the schema.** Fixtures and test bodies move to
   camelCase in the same PR that flips the schema, not in a follow-up.
5. **DB column references stay snake_case.** Anything inside
   `repositories/*` that does `.select("workspace_id, created_at")` or
   `.eq("workspace_id", ...)` is still snake_case — those are column names,
   not field keys.

## Validation gates

Every PR must pass before merge:

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
pnpm -C packages/plan-schema run test
```

PRs that touch web routing or visible behavior also require the manual
browser smoke-test described in [CLAUDE.md → Testing](../../CLAUDE.md#testing--required-for-uifrontend-changes).

## PR groupings

PRs are sliced so each is independently mergeable. The contract PR for a
domain ships in the same change as the route handler and web consumers that
read the affected fields — otherwise the API is broken between merges.

Order matters only for cross-PR conflicts. PRs **1, 2, 3, 5, 6, 7, 8** can
land in any order. **PR 4** (setup) is the largest and will conflict with
everything if delayed; recommend landing it first or last.

---

### PR 1: Agent dashboard responses → camelCase

**Touches**

- [contracts/agent-dashboard.ts](../../contracts/agent-dashboard.ts) — convert all
  response schemas. Rename internal DB-row mirrors with `Row` suffix where
  they exist.
  - `AgentDashboardVersionResponseSchema.latest_event_at` → `latestEventAt`
  - `BrokerRunSchema` (lines 16–29): `run_id`, `agent_id`, `created_at`,
    `started_at`, `completed_at`, `terminal_reason`, `tracker_kind`,
    `tracker_issue_key`, `issue_identifier`, `issue_state`, `updated_at`
  - `AgentToolCallEventSchema` (lines 48–69): `workspace_id`, `agent_id`,
    `run_id`, `task_id`, `event_type`, `tool_slug`, `error_code`,
    `error_message`, `started_at`, `completed_at`, `created_at`, `updated_at`
  - `BrokerTaskSchema` (lines 72–85): `task_id`, `run_id`, `input_tokens`,
    `output_tokens`, `total_tokens`, `last_event`, `last_event_at`,
    `updated_at`
  - `GatewayConfigStateSchema` (lines 88–97): `scope_type`, `scope_id`,
    `sync_status`, `sync_error`, `last_apply_status`, `last_apply_error`,
    `last_apply_at`, `last_applied_version`
  - `AgentToolCallEventCreateRequestSchema` (lines 117–132): all fields
- [apps/api/src/services/agent-dashboard.ts](../../apps/api/src/services/agent-dashboard.ts)
  — keep DB-row types snake_case (they mirror the table); add a mapping
  function that returns camelCase shapes to the route layer.
- [apps/api/src/routes/agent-dashboard.ts](../../apps/api/src/routes/agent-dashboard.ts)
  — call the new mapping; request body validation now expects camelCase.
- [apps/web/src/api/agent-dashboard.ts](../../apps/web/src/api/agent-dashboard.ts)
  — consumes camelCase responses.
- [apps/web/src/hooks/useAgentDashboard.ts](../../apps/web/src/hooks/useAgentDashboard.ts)
  — accesses `task.lastEventAt`, `task.inputTokens`, `task.outputTokens`,
  `task.totalTokens`, `task.lastEvent`, `task.runId`, `run.runId`.
- Any web component that reads run history, task details, or gateway config
  state — search for `.run_id`, `.task_id`, `.created_at`, `.completed_at`,
  `.last_event_at`, `.input_tokens`, `.output_tokens`, `.total_tokens`,
  `.tracker_kind`, `.tracker_issue_key`, `.issue_identifier`, `.issue_state`,
  `.scope_type`, `.scope_id`, `.sync_status`, `.last_apply_status`,
  `.last_apply_at`, `.last_applied_version` under `apps/web/src/`.
- Tests for the dashboard route and hook.

**Acceptance**

- API responses for `GET /api/agent-dashboard/*` use camelCase keys.
- `POST /api/agent-dashboard/.../events` accepts camelCase request bodies.
- Web dashboard renders identically.
- `pnpm -C apps/api run validate` and the web typecheck pass.

---

### PR 2: Agent health response → camelCase

**Touches**

- [contracts/agent-health.ts](../../contracts/agent-health.ts):
  - `AgentHealthFailureSchema`: `source_layer` → `sourceLayer`,
    `occurred_at` → `occurredAt`
  - `AgentHealthConfigSchema`: `gateway_sync_status`, `gateway_apply_status`,
    `last_error`
  - `AgentHealthRuntimeSchema`: `engine_status`, `instance_id`,
    `last_heartbeat_at`, `started_at`, `last_error`
  - `AgentHealthResponseSchema`: `agent_id`, `workspace_id`, `checked_at`,
    `last_failure`
- [apps/api/src/routes/setup.ts](../../apps/api/src/routes/setup.ts) — health
  endpoint at line 192 emits camelCase (mapping from underlying DB rows).
- Any web consumer of `GET /api/setup/:agentId/health` (search for
  `agent_health`, `last_heartbeat_at`, `engine_status` under
  `apps/web/src/`).

**Acceptance**

- `GET /api/setup/:agentId/health` returns camelCase.
- Health UI renders identically.

---

### PR 3: Plans + work items → camelCase

**Touches**

- [contracts/plans.ts](../../contracts/plans.ts):
  - `PlanTaskSchema`: `depends_on` → `dependsOn`, `completion_gates` →
    `completionGates`
  - `PlanBodySchema`: `schema_version`, `default_runner`, `default_model`
  - `PlanRecordSchema`: `workspace_id`, `schema_version`,
    `default_runner_kind`, `default_model`, `created_at`, `updated_at`
  - `PlanDraftFromPromptRequestSchema`: `workspace_id`, `default_runner`,
    `default_model`
  - `PlanReviewTaskSchema`, `PlanReviewPlanSchema`: all timestamp + id fields
- [contracts/work-items.ts](../../contracts/work-items.ts):
  - `WorkItemProjectionSchema`: `task_id`, `workspace_id`, `plan_id`,
    `depends_on`, `completion_gates`, `created_at`, `updated_at`
  - `WorkItemListResponseSchema`: `work_items` → `workItems`
  - `WorkItemDeleteResponseSchema`: `work_item` → `workItem`
- [packages/plan-schema/](../../packages/plan-schema) — confirm the in-package
  plan body schema matches contracts/plans.ts; update its tests.
- [apps/api/src/routes/plans.ts](../../apps/api/src/routes/plans.ts) and any
  work-items route — emit/consume camelCase, map from DB rows in the
  repository layer.
- Web consumers: search `apps/web/src/` for `.depends_on`, `.completion_gates`,
  `.schema_version`, `.default_runner`, `.default_model`,
  `.default_runner_kind`, `.work_items`, `.work_item`.
- Plan fixtures in `scripts/` and test files that build plan bodies with
  snake_case.

**Acceptance**

- Plan create/draft/review and work-item list/delete endpoints all use
  camelCase request bodies and response shapes.
- `pnpm -C packages/plan-schema run test` passes.
- Plan UI flow works end-to-end in the browser smoke test.

---

### PR 4: Setup contracts → camelCase (largest)

**Touches**

- [contracts/setup.ts](../../contracts/setup.ts) — convert all response and
  remaining request schemas (~40 fields). Rename DB-mirror schemas with
  `Row` suffix where they exist.
  - `SetupCustomTargetSchema`: `base_url`, `agent_id`
  - `SetupAgentSchema`: `workspace_id`, `model_settings`, `tool_policy`,
    `created_by_user_id`, `updated_at`
  - `SetupEngineInstanceSchema`: `instance_id`, `agent_id`, `workspace_id`,
    `started_at`, `last_health_at`, `updated_at`, `ws_connection_id`
  - `SetupRuntimeTargetSchema`: `agent_id`, `instance_id`
  - `SetupRuntimeHealthSchema`: `error_code`, `error_message`,
    `runtime_target`
  - `SetupGatewayConfigSchema`: `scope_type`, `scope_id`, `config_hash`,
    `config_json`, `updated_at`, `updated_by`
  - `SetupGatewayConfigStateSchema`: 11 fields
  - `SetupWorkspaceSchema`: `owner_user_id`, `created_at`
  - `SetupResponseSchema`: `gateway_config`, `gateway_config_state`
- [apps/api/src/routes/setup.ts](../../apps/api/src/routes/setup.ts) — every
  setup endpoint emits camelCase.
- All web consumers of setup endpoints under `apps/web/src/` (onboarding,
  agent config, gateway settings UI). Search for `.gateway_config`,
  `.config_hash`, `.config_json`, `.tool_policy`, `.model_settings`,
  `.created_by_user_id`, `.last_health_at`, `.ws_connection_id`,
  `.runtime_target`, `.error_code`.
- E2E setup flow tests.

**Acceptance**

- `GET /api/setup` and all `/api/setup/*` endpoints use camelCase.
- Onboarding flow works end-to-end in the browser.
- Agent setup and gateway config UI render identically.

**Note:** This PR is the largest and most disruptive. Land it first or last
to avoid merge conflicts with PRs 1–3, 5–8.

---

### PR 5: Agents response schemas → camelCase

**Touches**

- [contracts/agents.ts](../../contracts/agents.ts) — keep `StoredAgentSchema`
  as-is (rename to `StoredAgentRowSchema`; it mirrors the DB table).
  Convert response-only schemas:
  - Embedded duplicates of `BrokerRunSchema`, `BrokerTaskSchema`,
    `GatewayConfigStateSchema` (deduplicate against
    `contracts/agent-dashboard.ts` after PR 1).
  - `PlanReviewTaskSchema`, `PlanReviewPlanSchema`: dedupe with
    `contracts/plans.ts` (PR 3).
  - `AgentObservationEventSchema`: `occurred_at`, `run_id`, `task_id`
  - `AgentObservationHealthSchema`: `last_heartbeat_at`, `instance_id`,
    `latest_run`, `run_id`, `started_at`, `completed_at`, `updated_at`,
    `terminal_reason`, `last_failure`
  - `AgentObservationResponseSchema`: `observer_agent_id`, `agent_type`
- [apps/api/src/routes/](../../apps/api/src/routes) — agent observation routes
  emit camelCase via repository mapping.
- Web consumers of agent observation/health: search for `.observer_agent_id`,
  `.last_heartbeat_at`, `.latest_run`, `.terminal_reason`, `.last_failure`,
  `.occurred_at` under `apps/web/src/`.

**Acceptance**

- Agent observation endpoints use camelCase.
- `StoredAgentRowSchema` is the canonical DB-row mirror; route response
  shape uses a separate camelCase schema.
- Health/observation UI renders identically.

---

### PR 6: Agent control + worker bridge

**Touches**

- [contracts/agent-control.ts](../../contracts/agent-control.ts):
  `AgentControlMessageSchema` response — `workspace_id`, `target_agent_id`,
  `observer_agent_id`, `dispatch_status`, `created_by_user_id`,
  `created_at`. Requests are already camelCase.
- [contracts/worker-bridge.ts](../../contracts/worker-bridge.ts):
  - `WorkerBridgeSessionSchema` is parsing data from the upstream worker
    bridge service (snake_case wire). Rename to
    `WorkerBridgeSessionRowSchema` and keep snake_case.
  - Add a new `WorkerBridgeSessionSchema` (camelCase) that is what *we*
    return from `apps/api/src/routes/proxy.ts`.
  - Map row → external in the proxy route.
- [apps/api/src/routes/proxy.ts](../../apps/api/src/routes/proxy.ts) — control
  message and worker bridge endpoints map and emit camelCase.
- Web consumers of `POST /api/agents/:agentId/control/messages` and worker
  bridge sessions.

**Acceptance**

- Control message responses use camelCase.
- `WorkerBridgeSessionRowSchema` parses upstream snake_case; route emits
  camelCase to web.

---

### PR 7: Stored agent management → camelCase

**Touches**

- [contracts/stored-agent-management.ts](../../contracts/stored-agent-management.ts):
  `StoredAgentGatewayConfigSchema`: `base_url` → `baseUrl`, `agent_id` →
  `agentId`.
- The matching API route under `apps/api/src/routes/stored-agents.ts`.
- Web consumers of the stored-agent gateway config response.

**Acceptance**

- Stored agent gateway config endpoint uses camelCase.

---

### PR 8: Web broker + auth state cleanup

**Touches**

- [apps/web/src/api/broker.ts](../../apps/web/src/api/broker.ts) lines 94–248
  — replace snake_case field reads with camelCase. The API responses these
  read from must be camelCase first (this PR depends on the routes that
  produce them — currently mostly auth/bootstrap endpoints).
- [apps/web/src/stores/auth.ts](../../apps/web/src/stores/auth.ts) — same.
- The corresponding API routes that produce auth/bootstrap responses
  (search for `resolved_agent_id`, `ready_to_prepare`, `default_agents`,
  `bootstrap_id`, `session_id` under `apps/api/src/routes/`).
- The Zod request/response schemas backing those endpoints.

**Acceptance**

- Login + bootstrap flow returns camelCase from API and consumes camelCase
  in the web store.
- No `_id` / `_at` / `ready_to_` / `resolved_` accesses remain in
  `apps/web/src/api/` or `apps/web/src/stores/`.
- Browser smoke test of login → dashboard works.

---

## Tracking checklist

- [ ] PR 1: agent-dashboard
- [ ] PR 2: agent-health
- [ ] PR 3: plans + work-items
- [ ] PR 4: setup (largest)
- [ ] PR 5: agents (response schemas)
- [ ] PR 6: agent-control + worker-bridge
- [ ] PR 7: stored-agent-management
- [ ] PR 8: web broker + auth state

After all PRs land, add a CI lint that flags new snake_case keys in
`contracts/**/*Schema.ts` (excluding `*RowSchema`) and route handler
`req.body.*` reads.

## Out of scope

- The Elixir launcher and worker-bridge wire formats. We map at our service
  layer and leave their wire snake_case. See
  [CLAUDE.md → No Backwards Compatibility Shims](../../CLAUDE.md#no-backwards-compatibility-shims),
  exception 4.
- `packages/supabase-schema/src/database.types.ts` (generated; snake_case
  by definition).
- `supabase/` directory (DB migrations).
- Snake_case enum *values* like `local_runtime`, `openai_codex` — those are
  enum-like strings, governed by a separate convention in
  [CLAUDE.md → Enum/String Conventions](../../CLAUDE.md#enumstring-conventions),
  and stay snake_case.
