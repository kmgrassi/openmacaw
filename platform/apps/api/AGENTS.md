# Agent Documentation Index

This file is the table of contents for all documentation that agents and developers need to work effectively in this repository.

## Core

| Document | Purpose |
|----------|---------|
| [CLAUDE.md](CLAUDE.md) | Project overview, quick commands, TypeScript conventions |
| [WORKFLOW.md](WORKFLOW.md) | Task policy — how to pick up, execute, and land work |

## Default Engineering Posture

When choosing between a quick fix, a narrow patch, or a full refactor, agents
must choose the full refactor. Fix the root cause across routes, services,
contracts, callers, tests, and docs so the long-term system gets simpler
instead of accumulating temporary compatibility paths.

## Tool CRUD Conventions

Database-backed agent tools must use the shared CRUD shape:
`resource.create`, `resource.read`, `resource.update`, `resource.delete`, and
`resource.list` for collection queries. Avoid ambiguous verbs such as
`manage`, `save`, `edit`, and `set` for database-backed resources.

When an API change adds or changes one of these tools, update the route,
service/repository, Zod contract, runtime tool registry, platform grant catalog,
restricted allowlists, tests, prompts, and schema/enum docs together. See
[../../docs/reference/tool-crud-conventions.md](../../docs/reference/tool-crud-conventions.md).

## Guides

| Document | Purpose |
|----------|---------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, data flow, upstream dependencies |
| [docs/TYPESCRIPT.md](docs/TYPESCRIPT.md) | TypeScript coding standards and patterns for this repo |
| [docs/LOCAL_DEV.md](docs/LOCAL_DEV.md) | Local development setup, running, debugging |
| [docs/LINTING.md](docs/LINTING.md) | ESLint and Prettier config, how to run and fix |
| [docs/TESTING.md](docs/TESTING.md) | Testing strategy, writing tests with Vitest |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Build, deploy, rollback procedures |
| [docs/PR_REVIEW.md](docs/PR_REVIEW.md) | PR creation checklist and review criteria |
| [docs/OBSERVABILITY.md](docs/OBSERVABILITY.md) | Logging, health checks, production monitoring |

## Scripts

| Script | Purpose |
|--------|---------|
| [scripts/validate.sh](scripts/validate.sh) | Full pre-commit validation (lint + format + typecheck + test) |
| [scripts/healthcheck.sh](scripts/healthcheck.sh) | Verify local or deployed server is running correctly |

## Config Files

| File | Purpose |
|------|---------|
| `eslint.config.js` | ESLint flat config for TypeScript |
| `.prettierrc.json` | Prettier formatting rules |
| `tsconfig.json` | TypeScript compiler options |
| `.env.example` | Environment variable template |
