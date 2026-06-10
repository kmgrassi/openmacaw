# Parallel Agent Runtime — Agent Guide

## Project Structure

Elixir/OTP application with two main components:

```
apps/orchestrator/     — Main Elixir application (orchestrator + web endpoint)
apps/launcher/         — Launcher for managing orchestrator instances
docs/                  — Scoping documents, runbooks, PR plans
scripts/               — Start scripts, smoke tests
```

## Before You Start

1. Ensure Erlang/Elixir installed (`mise install`)
2. `cd apps/orchestrator && mix setup`
3. Copy `.env` from the main repo or a worktree

## Validation — REQUIRED Before Every Commit

```bash
cd apps/orchestrator
mix compile --warnings-as-errors
mix test
```

If either step fails, fix it before committing. Do not push code that
fails compilation or tests.

## Testing — Full Stack

Most changes in this repo need the **platform** running too. The full
local stack:

```bash
# Terminal 1: Start runtime (launcher + orchestrator)
pnpm run start:local

# Terminal 2: Start platform (in parallel-agent-platform repo)
cd ../parallel-agent-platform && pnpm run dev
```

**Verify both are healthy:**
```bash
curl http://127.0.0.1:4000/api/v1/health   # Orchestrator
curl http://127.0.0.1:4100/health           # Launcher
curl http://127.0.0.1:3100/health           # Platform API
```

For local model testing, also start:
```bash
# Terminal 3: Ollama (if not already running)
ollama serve

# Terminal 4: Local runtime helper (from local-runtime-helper repo)
cd ../local-runtime-helper
go run ./cmd/local-runtime-helper start --config ./dev-runtime.toml
```

## Testing — Diagnostic Endpoint

The platform has a diagnostic endpoint for debugging agent routing:
```bash
curl "http://127.0.0.1:3100/api/diagnostic/agents/<agent-id>?workspaceId=<workspace-id>"
```

This shows: routing rules, execution profile resolution, local runtime
connectivity, launcher health, and specific blockers.

## Browser Login And Planner Work Item Smoke

Use this smoke when changing planner tools, gateway chat, auth/session
handling, or work item persistence.

1. Start the runtime and platform:
   ```bash
   # Runtime repo
   pnpm run start:local

   # Platform repo
   cd ../parallel-agent-platform && pnpm run dev
   ```
2. Open `http://127.0.0.1:5173` in the browser and sign in with the
   local Supabase test account/session configured for the platform. If
   the browser already has a session, go directly to the planning agent
   dashboard URL.
3. Select the Planning Agent and send a prompt like:
   ```text
   Create a plan named Browser Work Item Smoke <timestamp> with exactly one actual task named Verify direct work item creation. Use the task creation tool.
   ```
4. Confirm the assistant returns both a plan ID and a task/work item ID.
5. Query Supabase REST using the service role key from `apps/orchestrator/.env`.
   Do not print or commit the key.
   ```bash
   curl "$SUPABASE_URL/rest/v1/work_items?title=eq.Verify%20direct%20work%20item%20creation&select=id,task_id,plan_id,title,state,source,metadata" \
     -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"

   curl "$SUPABASE_URL/rest/v1/task?id=eq.<assistant-task-id>&select=id,name,plan_id,status" \
     -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
     -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
   ```
6. The expected result is a `work_items` row whose `id` matches the
   assistant-reported task ID, `source` is `planner`, and `metadata`
   records planner tool creation. The legacy `task` query should return
   `[]`; direct planner task creation must not create a `task` row.

## No Backwards Compatibility Shims

When a value, format,
or API shape needs to change:

1. **Change it everywhere** across all repos in the same PR or set of PRs
2. **Update DB constraints/migrations** if the change affects stored values
3. **Do NOT add "also accept the old form" logic** — no dual-format support,
   no legacy aliases, no normalization hacks
4. **The only exception** is a truly external API where you can't coordinate
   the change

When you encounter inconsistency, fix it at the source. Refactor through
the entire codebase rather than adding a compatibility layer.

## Local Services

| Service | Port | Repo |
|---------|------|------|
| Runtime orchestrator | 4000 | This repo |
| Runtime launcher | 4100 | This repo |
| Platform API | 3100 | parallel-agent-platform |
| Platform web UI | 5173 | parallel-agent-platform |
| Ollama | 11434 | System |

## Enum/String Conventions

Execution profile enum-like values must match the runtime allowlists in
`apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex`:

- Runner kinds: `codex`, `claude_code`, `openclaw`, `openclaw_ws`, `computer_use`, `manager`, `planner`, `local_relay`, `local_model_coding`
- Providers: `openai`, `openai_codex`, `codex`, `anthropic`, `openai_compatible`, `openclaw`, `computer_use`, `local`

Do not invent aliases such as `local_runtime`, `openai-compatible`, or
`openai-codex` for execution profiles.

## Database Shape Conventions

Default to explicit relational schema: real tables, join tables, and typed
columns that can be represented in generated types and checked by the database.
Avoid using a table as a generic JSONB object store, and avoid putting core
domain state into JSON blobs just to move faster.

JSONB is appropriate only for truly schemaless external payloads, transient
provider-specific metadata, or values whose shape is intentionally opaque to the
application. If application code needs to query it, join on it, validate it,
enforce constraints on it, or rely on its fields for behavior, model those
fields as columns or related tables instead.

## Key Architecture Rules

- **Execution profiles drive routing.** The platform resolves which
  model/provider/credentials to use. The runtime receives the profile
  and dispatches accordingly.
- **Runner.LocalRelay** dispatches to local models via the relay socket.
  The helper daemon connects and registers runner kinds.
- **TokenValidator** authenticates relay connections. Dev uses config-based
  tokens (`config/dev.exs`). Production should use the DB-backed adapter.
- **No hardcoded models.** Runners should read model/provider from the
  execution profile, not hardcode provider URLs or API keys.

## Database Connection Conventions — Always PostgREST

All runtime DB access in the launcher path **must** go through
`SymphonyElixir.PostgRESTClient`. The same Supabase service-role token
(`SUPABASE_SERVICE_ROLE_KEY`) the orchestrator already has in its container
env is used to talk to the PostgREST API. New modules that need to query
Supabase should mirror the pattern in
`apps/orchestrator/lib/symphony_elixir/manager/workspaces/database.ex`
or `apps/orchestrator/lib/symphony_elixir/scheduled_task/repository.ex`.

**There is no Ecto Repo. PostgREST is the only DB path.** `SymphonyElixir.Repo`
was removed entirely. It only started when `SUPABASE_POOLER` was configured,
which the production launcher escript never sets — so any code path that
reached the Repo crashed at runtime with `"could not lookup Ecto repo
SymphonyElixir.Repo"`, even when it worked in dev or under `mix test`. That
exact bug took down the Manager Agent for a day, then resurfaced in the
local-relay token validator and heartbeat recorder. Rather than keep feeding
a pooler URL the launcher never has, all of those were ported to PostgREST
and the Repo (plus `ecto_sql`/`postgrex`) was deleted.

Rationale: PostgREST gives us one credential, one client, one set of patterns,
and works in launcher escript mode with no Postgres pooler to provision or
forget. `ecto` is still a dependency, but only for in-memory schemas and
changesets used for validation — never for DB connections.

Do NOT add `ecto_sql`, `postgrex`, a new `Repo`, or any direct-Postgres
connection. New modules that query Supabase mirror
`apps/orchestrator/lib/symphony_elixir/manager/work_items/database.ex`.

## Database Schema Sync — REQUIRED After DB Migrations

All database migrations live in the `harper-server` repository. Do not add
Supabase migration files to this repository, and do not run forced database
migrations from the runtime or platform repos.

To make a database change, create the migration file in `harper-server`, send
it through normal code review, and merge it there. The migration is applied by
the `harper-server` CI/deploy pipeline as it is promoted to production.

After database migrations are added to `harper-server`, the generated schema
files in this repo must be updated:

```bash
pnpm run supabase:schema:sync
```

This regenerates:
- `supabase/generated/types.ts` — TypeScript types
- `supabase/generated/postgrest-schema.json` — PostgREST bridge metadata
- `apps/orchestrator/priv/generated/postgrest-schema.json` — same, for Elixir

The `BRIDGE_TABLES` list in `scripts/append-supabase-jsdoc-types.mjs`
controls which tables are included in the PostgREST bridge. If you add
a new table that the runtime needs to query, add it to that list.

Runtime only vendors generated schema artifacts. The schema sync command does
not generate or require `supabase/migrations`.

**Failure to sync causes runtime crashes** — the Elixir `SupabaseSchema`
module uses the bridge file to check column existence. Missing tables
cause `function_clause` errors at startup.

## Worktree Conventions

- Create a worktree per PR
- Copy `.env` into worktrees
- Always push to a branch and create a PR — never commit directly to main

## PR Bundling

GitHub Actions minutes are billed. Each PR fires the full workflow suite on
every push, so opening one PR per tiny task multiplies CI cost. Bundle
closely-related changes into a single PR when they:

- Touch overlapping files (e.g. a contract change plus every consumer)
- All must merge for any of them to ship value
- Share a single reviewer or domain owner

Keep PRs split when the changes have independent rollout risk, touch
production infrastructure, or need to be revertable in isolation. When
implementing a multi-item scope or PR plan, default to bundling
closely-related items unless they have meaningfully different review
surfaces.

## Related Repos

- `parallel-agent-platform` — TypeScript API + React frontend
- `local-runtime-helper` — Go daemon for local model relay
- `harper-server` — Supabase DB migrations
