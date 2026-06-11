# OpenMacaw Platform API — Agent Guide

## Project Overview

The OpenMacaw platform API is a TypeScript/Express HTTP proxy gateway to an upstream Elixir orchestration API. It provides stable REST contracts, timeout handling, and error normalization.

- **Runtime**: Node.js >= 20 (ES modules)
- **Language**: TypeScript 5.x with strict mode
- **Framework**: Express 4.x
- **Entry point**: `src/index.ts`
- **Build output**: `dist/`

## Quick Commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Dev (hot reload) | `pnpm run dev` |
| Run once (no watch) | `pnpm run local` |
| Build | `pnpm run build` |
| Start production | `pnpm start` |
| Lint | `pnpm run lint` |
| Lint + fix | `pnpm run lint:fix` |
| Format check | `pnpm run format:check` |
| Format fix | `pnpm run format` |
| Type check | `pnpm run typecheck` |
| Run tests | `pnpm test` |
| Full validation | `pnpm run validate` |

## TypeScript Conventions

- Prefer the full refactor over quick fixes. When choosing between a quick
  fix, a narrow patch, or a refactor that leaves the system cleaner, choose
  the refactor. Optimize for long-term maintainability and remove the
  underlying cause so the same issue does not resurface later.
- **Strict mode is on.** Do not use `any`. Use `unknown` and narrow with type guards.
- Use ES module imports (`import`/`export`), never CommonJS (`require`).
- Prefer `type` imports where possible: `import type { Request } from "express"`.
- Use `interface` for object shapes that may be extended; use `type` for unions, intersections, and aliases.
- Name types in PascalCase. Name variables and functions in camelCase.
- Prefix unused callback params with `_` (e.g., `_req`).
- Use `const` by default. Use `let` only when reassignment is needed. Never use `var`.
- Use template literals over string concatenation.
- Always handle `Promise` rejections. Every `async` route handler must have a `try/catch`.

## Express Patterns

- All routes return JSON via `res.status(N).json(...)`.
- Error responses use the `errorPayload(code, message, details?)` helper for consistent shape: `{ error: { code, message, details } }`.
- Proxy routes go through `orchestratorRequest(path, init?)` which handles timeouts and content-type detection.
- Proxy errors are handled by `handleProxyError(res, error)` — returns 504 for timeouts, 502 for unreachable.

## File Structure

```
src/
  index.ts          # All routes and server setup (will be split as it grows)
docs/               # Developer and agent documentation
scripts/            # Validation and automation scripts
dist/               # Compiled JS output (gitignored)
```

## Supabase Access

New Supabase queries belong in table-focused modules under
`src/repositories/` or in service modules when the operation spans multiple
tables. Do not add new query helpers to a catch-all Supabase module.

Default to normalized database tables with explicit typed columns and join
tables. JSONB object columns should be rare and reserved for data that is
genuinely unstructured, externally owned, or intentionally opaque. Do not
store structured application state in a JSON blob when it can be represented
with columns and relations; explicit schema keeps Supabase types, constraints,
queries, and refactors type-safe.

## Tool CRUD Conventions

Database-backed agent tools must use the shared CRUD shape:
`resource.create`, `resource.read`, `resource.update`, `resource.delete`, and
`resource.list` for collection queries. Avoid ambiguous verbs such as
`manage`, `save`, `edit`, and `set` for database-backed resources.

When an API change adds or changes one of these tools, update the route,
service/repository, Zod contract, runtime tool registry, platform grant catalog,
restricted allowlists, tests, prompts, and schema/enum docs together. See
[../../docs/reference/tool-crud-conventions.md](../../docs/reference/tool-crud-conventions.md).

## Refactor Over Quick Fixes

When choosing between a quick fix, a narrow patch, or a full refactor, choose
the full refactor. Optimize for the server we want to maintain long term, not
the smallest diff that happens to pass today.

- Fix the root cause and update every affected route, repository, service,
  contract, test, and doc.
- Do not leave temporary branches, compatibility paths, TODO follow-ups, or
  duplicated logic that will need to be cleaned up later.
- If the correct refactor crosses API, contract, web, or related-repo
  boundaries, scope and execute that full change instead of hiding the
  inconsistency behind an adapter.

## Environment Variables

Defined in `.env.example`. Copy to `.env` for local dev:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3100` | Server listen port |
| `ORCHESTRATOR_BASE_URL` | `http://127.0.0.1:4000` | Upstream Elixir API |
| `ORCHESTRATOR_REQUEST_TIMEOUT_MS` | `15000` | Proxy timeout in ms |

## Validation Before Committing

Always run the full validation suite before committing:

```bash
pnpm run validate
```

This runs lint, format check, type check, and tests in sequence. All must pass.

## Agent Documentation Index

See [AGENTS.md](AGENTS.md) for a table of contents of all docs relevant to agent-driven development.
