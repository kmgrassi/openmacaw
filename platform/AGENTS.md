# Parallel Agent Platform — Agent Guide

## Project Structure

Monorepo with two apps and shared contracts:

```
apps/api/          — Express API server (TypeScript, port 3100)
apps/web/          — React frontend (Vite, port 5173)
contracts/         — Shared Zod schemas and TypeScript types
supabase/          — Generated Supabase types
packages/          — Shared packages (plan-schema, etc.)
scripts/           — Dev scripts and test harnesses
docs/              — Scoping documents, PR plans, and reference material
                     (organized by status — see Docs Conventions below)
```

## Before You Start

1. Copy `.env` if not present (or check worktrees for one)
2. `pnpm install` from repo root
3. `pnpm run dev` starts both API (hot reload) and web (Vite HMR)

## Validation — REQUIRED Before Every Commit

Run these before committing. Do not push code that fails validation.

```bash
# All commands run from the repo root

# API — lint, format, typecheck, tests
pnpm -C apps/api run validate

# Web — typecheck
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json

# Plan schema (if changed)
pnpm -C packages/plan-schema run test
```

If any step fails, fix it before committing. Do not skip validation.
Format all code changes with the repo's Prettier configuration before
committing so the formatting checks do not fail.

## Testing — REQUIRED For UI/Frontend Changes

For any change that affects the UI or user-facing behavior:

1. Start the dev server: `pnpm run dev` (from repo root)
2. Open http://localhost:5173 in a browser
3. **Log in with dev credentials.** If the app shows `/login`, click
   **Use dev credentials**. That button appears when
   `VITE_DEV_LOGIN_EMAIL` and `VITE_DEV_LOGIN_PASSWORD` are set in
   `apps/web/.env`. If the button is missing, copy those vars from
   `apps/web/.env.example` and restart `npm run dev`. Do **not** sign up a
   new user or hardcode credentials in a test; always use the dev
   credentials button.
4. Test the feature you changed — verify it works visually
5. Check the browser console for errors
6. Test the happy path AND edge cases
7. Only report the task as complete after verifying in the browser

**Type checking and tests verify code correctness, not feature correctness.**
A passing typecheck does not mean the feature works.

## Testing — REQUIRED For API Changes

For any change that affects API endpoints:

1. Start the dev server: `pnpm run dev`
2. Hit the endpoint with curl and verify the response
3. Check the API logs at `.run-logs/api.log` for errors
4. Use the diagnostic endpoint for agent-related changes:
   ```bash
   curl http://127.0.0.1:3100/api/diagnostic/agents/<agent-id>?workspaceId=<workspace-id>
   ```

## Enum/String Conventions

All enum-like values use **snake_case** (underscores, never hyphens):

- Runner kinds: see `contracts/runner-kinds.ts` (`RUNNER_REGISTRY`) — that
  file is the canonical list. Today it contains `codex`, `claude_code`,
  `openclaw`, `local_runtime`, `local_relay`, `local_model_coding`,
  `llm_tool_runner`, `planner`, `openclaw_ws`, `openclaw_http_sse`,
  `computer_use`. Harper-server's `routing_rule.runner_kind` CHECK
  constraint must remain a superset; the cross-repo enum drift check
  (`scripts/check-cross-repo-enums.mjs`) asserts this.
- Providers: `openai`, `anthropic`, `openai_compatible`, `openai_codex`
- Execution kinds: `filesystem`, `shell`, `api`, `database`

The DB check constraints are the source of truth. See `contracts/runner-kinds.ts`
for the canonical list. Never introduce a hyphenated value.

## Field Naming Conventions (Case Style)

We use a **layered convention** for object keys. The case depends on which
layer you are in, and conversion happens once at the API boundary.

| Layer                                                                                        | Case         | Examples                                    |
| -------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------- |
| DB (Postgres columns, Supabase row types)                                                    | `snake_case` | `workspace_id`, `created_at`, `tool_policy` |
| API boundary (HTTP request/response bodies, query params, WS payloads, route handler params) | `camelCase`  | `workspaceId`, `createdAt`, `toolPolicy`    |
| TypeScript variables / function params / React props                                         | `camelCase`  | `workspaceId`, `agentId`                    |

Rules:

1. **Zod request/response schemas in `contracts/`** use `camelCase` keys.
   The only exception is `*Row` schemas that intentionally mirror a DB table
   shape — those keep `snake_case` and are typically named with a `Row`
   suffix so the intent is obvious.
2. **Express route handlers** read `req.body.fooBar` / `req.query.fooBar`,
   never `req.body.foo_bar`. The Zod request schema enforces this.
3. **Web `fetch` calls** send `camelCase` bodies and read `camelCase`
   responses. No client-side conversion to/from snake_case.
4. **Conversion lives in repositories / route handlers**, where the DB row
   is mapped to the API response shape (or vice versa). Never inside web
   code, never inside transport helpers (`brokerFetch`, etc.).
5. **Upstream services that we do not control** (e.g. the Elixir launcher,
   worker bridge) may emit `snake_case`. Our service layer
   (`apps/api/src/services/*`) parses those responses with `Row`-style
   schemas and converts to `camelCase` before returning to our own routes.

If you find a Zod schema, route, or web file that violates this, fix it at
the source rather than papering over it with `keys.replace(/_/g, "")` or
`camelcase-keys` in transport. See
[docs/active/api-case-convention-pr-plan.md](docs/active/api-case-convention-pr-plan.md)
for the in-progress refactor punch list.

## Tool CRUD Conventions

Database-backed agent tools use the standard
`resource.create` / `resource.read` / `resource.update` / `resource.delete`
shape, with `resource.list` for collection queries. Use snake_case resource
names, for example `scheduled_task.create` and `scheduled_task.delete`.

Do not create ambiguous database-backed tools such as `resource.manage`,
`resource.save`, or `resource.edit`. `create` must not update existing rows,
and `update` must not create missing rows. Domain-specific actions are allowed
when CRUD does not describe the behavior, for example
`scheduled_task.run_now`.

When adding a tool, update contracts, API routes/services, runtime tool
registry and implementation, platform tool catalog, grant defaults, restricted
allowlists, tests, prompts, and any DB schema/enum constraints in the same PR
series. See
[docs/reference/tool-crud-conventions.md](docs/reference/tool-crud-conventions.md).

## Key Architecture Rules

- **Prefer the full refactor over quick fixes.** When choosing between a
  quick fix, a narrow patch, or a refactor that leaves the system cleaner,
  choose the refactor. Optimize for long-term maintainability and remove the
  underlying cause so the same issue does not resurface later.
- **No hardcoded models.** Agents get their model from the execution profile
  (routing rules), not hardcoded in runner code.
- **No hardcoded credentials.** Agents use stored credentials from the
  `credential` table, resolved through the execution profile.
- **DB constraints enforce correctness.** Unique constraints, check constraints,
  and foreign keys catch bugs that application code misses.
- **Surface errors, never swallow them.** Every Supabase query error must be
  logged with full details (code, message, details, hint). Use
  `assertSupabaseSuccess()` from `lib/supabase-errors.ts`.
- **Messages belong to agents, not transports.** Message history persists
  across model changes. Each message stores which model generated it.

## Refactor Over Quick Fixes

When choosing between a quick fix, a narrow patch, or a full refactor, choose
the full refactor. Optimize for the codebase we want to maintain long term,
not the smallest diff that happens to pass today.

- Fix the root cause and update every affected caller, contract, test, and doc.
- Do not leave temporary branches, compatibility paths, TODO follow-ups, or
  duplicated logic that will need to be cleaned up later.
- If the correct refactor crosses package, API, web, or related-repo
  boundaries, scope and execute that full change instead of hiding the
  inconsistency behind an adapter.

## No Backwards Compatibility Shims

When a value, format,
or API shape needs to change:

1. **Change it everywhere** across all repos in the same PR or set of PRs
2. **Update DB constraints/migrations** if the change affects stored values
3. **Do NOT add "also accept the old form" logic** — no dual-format support,
   no legacy aliases, no `if (oldFormat) normalize()` hacks
4. **The only exception** is a truly external API (e.g., a webhook URL that
   third parties call) where you can't coordinate the change

Examples of what NOT to do:

- `body.provider.replace(/-/g, "_")` — instead, fix the source to send the right value
- Re-exporting a renamed function under the old name "for compatibility"

Note: `local_relay` and `local_runtime` are distinct runner kinds, not a
naming drift. `local_runtime` = registered local-machine identity (direct
transport, has its own table and routes). `local_relay` = helper-daemon
websocket transport (runtime's `SymphonyElixir.LocalRelay`). See the
JSDoc on each entry in `contracts/runner-kinds.ts`.

When you encounter inconsistency, fix it at the source. Refactor through
the entire codebase rather than adding a compatibility layer.

## Generated Files

- **Never manually edit generated files.** In particular,
  `packages/supabase-schema/src/database.types.ts` must only change by running
  `pnpm run db:schema:sync` against the intended Supabase project.
- **All database migrations live in the `harper-server` repo.** Do not create
  Supabase migration files in this repo.
- **Do not run forced database migrations.** Schema changes must be made as
  migration files in `harper-server`, then code reviewed, merged, and applied
  by that repo's CI/CD pipeline.
- If generated Supabase types do not match migrations or application code,
  treat that as a schema deployment or migration-ordering problem. Fix the
  migration state first, then regenerate and sync the types.
- Do not patch missing generated RPC/table/type entries by hand, even as a
  temporary typecheck fix.

## Contract Changes

- For HTTP boundary changes, update the Zod contracts in `contracts/` first,
  then update API behavior, web callers, and route tests.
- For DB boundary changes, add the Supabase migration in `harper-server`
  first. After that migration is reviewed, merged, and applied by CI/CD,
  regenerate database types here with `pnpm run db:schema:sync`.
- See `docs/reference/contracts-directory-guidelines.md` for the repo-local
  contract change order and PR review signals.

## Docs Conventions

The `docs/` directory is split by **status**, not topic. The full index lives
at [`docs/implementation_docs_index.md`](docs/implementation_docs_index.md).

| Folder | Contents |
| --- | --- |
| `docs/active/` | In-flight scoping docs and PR plans |
| `docs/reference/` | Durable design docs, conventions, runbooks |
| `docs/shipped/` | PR plans whose work has merged (historical) |
| `docs/superseded/` | Replaced by a newer doc — follow the pointer at the top |

**When you start work on a PR**, check `docs/active/` for a scoping doc that
covers it. If one exists, treat it as the source of truth — read it, update it
as the design clarifies, and link it from the PR description. If no doc exists
and the change is non-trivial, write a short scoping doc in `docs/active/`
before opening PRs.

**When the PR(s) covering an `active/` doc merge**, move the doc to
`docs/shipped/` in the same PR (or the final PR of the series):

```bash
git mv docs/active/foo.md docs/shipped/
```

Also remove the doc's bullet from the **Active** section of
`docs/implementation_docs_index.md`. Don't leave shipped docs in `active/` —
that's how the index lost its meaning before.

## Local Services

| Service              | Port  | What                |
| -------------------- | ----- | ------------------- |
| Platform web UI      | 5173  | React app (Vite)    |
| Platform API         | 3100  | Express proxy       |
| Runtime orchestrator | 4000  | Elixir orchestrator |
| Runtime launcher     | 4100  | Elixir launcher     |
| Ollama               | 11434 | Local model server  |

Start platform: `pnpm run dev` (from repo root)
Start runtime: `pnpm run start:local` (from parallel-agent-runtime)

## Environment Variables

Required in `.env` at repo root:

| Variable                    | Description             |
| --------------------------- | ----------------------- |
| `SUPABASE_PROJECT_ID`       | Supabase project ref    |
| `SUPABASE_URL`              | Supabase API URL        |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key        |
| `OPENAI_API_KEY`            | For agents using OpenAI |

## Worktree Conventions

- Create a worktree per PR: `git worktree add -b <branch> /path/to/<name> main`
- Copy `.env` into worktrees: `cp .env /path/to/<worktree>/.env`
- Always push to a branch and create a PR — never commit directly to main

## Related Repos

- `parallel-agent-runtime` — Elixir orchestrator/launcher
- `local-runtime-helper` — Go daemon for local model relay
- `harper-server` — Supabase DB migrations

## Sub-App Guides

- API: see `apps/api/CLAUDE.md`
