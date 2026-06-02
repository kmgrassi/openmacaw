# Tool CRUD Conventions

Status: reference

Use this convention whenever an agent tool reads or mutates a persistent
database-backed resource. The goal is that agents can infer the behavior of a
tool from its name and that platform, runtime, contracts, grants, and docs all
use the same vocabulary.

## Naming

Tool names use `resource.action` with snake_case resource names:

- `resource.create`
- `resource.read`
- `resource.update`
- `resource.delete`
- `resource.list` when agents need collection queries

Examples:

- `scheduled_task.create`
- `scheduled_task.read`
- `scheduled_task.update`
- `scheduled_task.delete`
- `scheduled_task.list`

Do not introduce vague database-backed verbs such as `manage`, `save`, `edit`,
or `set`. If a tool is not a CRUD operation, name it for the specific domain
action, such as `scheduled_task.run_now`.

## Semantics

`create` inserts a new resource. It must not update an existing row unless the
tool is explicitly named `upsert`, and new tools should avoid upsert semantics
unless there is a strong idempotency requirement.

`read` returns one resource by stable id. It should fail clearly when the id is
missing, unknown, or outside the caller's scope.

`update` mutates one existing resource by stable id. It must not create a new
row when the id is missing or unknown.

`delete` removes the resource from active use. The backing implementation may
soft-delete, disable, or cancel the row when history must be retained, but the
tool contract must document that behavior.

`list` returns a scoped collection. It should support filters needed for safe
selection before `read`, `update`, or `delete`.

## Required Updates

When adding or changing a database-backed tool, update every boundary that owns
the tool contract:

- Zod contracts and shared TypeScript types in `contracts/`.
- API routes, services, repositories, and tests in `apps/api/`.
- Runtime tool registry, runtime tool implementation, and runtime tests.
- Platform tool catalog, grant defaults, restricted allowlists, and policy
  tests.
- Harper server migrations, RLS, check constraints, and generated Supabase
  types when the database shape changes.
- Agent-facing prompts or tool descriptions that teach agents when to call the
  tool.
- Relevant README, `AGENTS.md`, `CLAUDE.md`, and active scoping docs.

If a tool introduces a new enum-like string such as a `kind`, `status`, or
`source`, add it to the schema/constraint inventory in the same PR series.
Do not leave it as an undocumented literal in only one repo.
