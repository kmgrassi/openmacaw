# OpenMacaw Supabase Data Model Inventory

This inventory scopes the database surface that should move out of the reused
Harper Supabase project and into a dedicated OpenMacaw Supabase project.

The companion SQL bootstrap is
[`openmacaw-schema.sql`](openmacaw-schema.sql). It is intended for a new
Supabase project and recreates the OpenMacaw-owned tables, helpers, indexes,
and minimal RLS policies. See [README.md](README.md) for the Supabase project
creation and migration workflow.

## Sources Reviewed

- `platform/packages/supabase-schema/src/database.types.ts`
- `runtime/supabase/generated/types.ts`
- `runtime/apps/orchestrator/priv/generated/postgrest-schema.json`
- Platform API Supabase access in `platform/apps/api/src/repositories/` and
  `platform/apps/api/src/services/`
- Runtime PostgREST access in `runtime/apps/orchestrator/lib/`
- Schema sync scripts in `platform/scripts/` and `runtime/scripts/`

## Included Data Model

Core identity and workspace tables:

- `user`
- `workspaces`
- `workspace_members`
- `workspace_settings`

Agent configuration and launch state:

- `agent`
- `agent_default_assignment`
- `agent_heartbeat_config`
- `engine_instance`
- `gateway_config`
- `gateway_config_state`
- `gateway_config_versions`
- `routing_rule`
- `routing_rule_match`

Runtime execution and observability:

- `broker_run`
- `broker_task`
- `agent_tool_call_event`
- `event_log`
- `session_thread`
- `message`
- `work_item_comments`
- `escalation`

Planning and work tracking:

- `plan`
- `task`
- `work_items`
- `scheduled_task`
- `scheduled_task_run`
- `planning_profile`
- `planning_profile_versions`

Credentials, tools, and grants:

- `credential`
- `credential_alias`
- `tool`
- `tool_call`
- `agent_tool`
- `agent_tool_grant`
- `tool_policy_template`
- `tool_policy_template_tool`

Local runtime and workspace resources:

- `local_runtime_machine`
- `local_runtime_token`
- `workspace_resource`
- `workspace_resource_grant`
- `workspace_resource_location`
- `workspace_resource_credential`
- `agent_resource_grant`

Learning and memory:

- `memory_items`
- `memory_hybrid_search` RPC stub

## Intentionally Excluded

The generated Harper-derived schema contains additional tables that are not
part of the current OpenMacaw runtime/platform surface, including authz tuple
tables, outreach/email tables, group/social tables, qualification tables,
factory/event-ledger tables, and unrelated content tables.

Those tables should stay out of the initial OpenMacaw Supabase project unless a
future OpenMacaw feature explicitly reintroduces them.

## Compatibility Notes

Two current OpenMacaw code paths reference tables that are not present in the
generated Supabase type package:

- `agent_tool_call_event`
- `agent_resource_grant`

The SQL includes both as compatibility tables. The resource-dispatch path also
expects `workspace_resource` fields named `resource_type`, `provider`,
`provider_url`, `display_name`, `deleted_at`, and `metadata_json`; the SQL adds
those compatibility columns alongside the generated `workspace_resource`
columns.

## New Project Bootstrap

1. Create a new Supabase project.
2. Create an initial migration with `supabase migration new openmacaw_schema`.
3. Copy `docs/supabase/openmacaw-schema.sql` into the generated migration file.
4. Test locally with `supabase db reset`.
5. Link the new project with `supabase link --project-ref <project-ref>`.
6. Preview and push the migration with `supabase db push --dry-run`, then
   `supabase db push`.
7. Configure OpenMacaw environment variables to point at the new project:
   `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the browser-facing anon key.
8. Run the existing schema sync commands to regenerate local type artifacts:
   `pnpm -C platform run db:schema:sync` and
   `pnpm -C runtime run supabase:schema:sync`.
9. Re-run platform/runtime smoke flows against the new project before migrating
   real workspace data.

The SQL recreates schema and minimal access policy only. It does not copy rows
from the reused Harper project.
