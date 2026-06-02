# Symphony Express Server (TypeScript)

Thin HTTP layer that proxies requests to the Symphony orchestration API.

## Why this exists

This service is a starting point for a dedicated TypeScript/Express server that can:

- provide stable API contracts for clients,
- query the orchestration layer,
- later host provider/worker abstraction endpoints,
- enforce auth/rate limits without coupling to Elixir internals.

## Current endpoints

This API is the launcher bridge client boundary. It now splits responsibilities between database-backed agent metadata, launcher session management, and orchestrator health/runtime proxying:

- `GET /livez` → local process liveness only
- `GET /health` → `${ORCHESTRATOR_BASE_URL}/api/v1/health`
- `GET /api/agents` → database-backed agent inventory/auth state
- `POST /api/agents` → `${ORCHESTRATOR_BASE_URL}/api/v1/agents`
- `GET /api/agents/:identifier` → `${ORCHESTRATOR_BASE_URL}/api/v1/:identifier`
- `PATCH /api/agents/:identifier` → `${ORCHESTRATOR_BASE_URL}/api/v1/:identifier`
- `DELETE /api/agents/:identifier` → `${ORCHESTRATOR_BASE_URL}/api/v1/:identifier`
- `POST /api/agents/refresh` → `${ORCHESTRATOR_BASE_URL}/api/v1/refresh`
- `GET /api/agents/:identifier/messages` → `${ORCHESTRATOR_BASE_URL}/api/v1/:identifier/messages`
- `GET /api/stored-agents/:id/credentials` → database-backed credential metadata for a single agent
- `POST /api/stored-agents/:agentId/credentials/:credentialId/launch` → server-side launch using stored credential references
- `POST /api/work-items` → manual task ingest into canonical `task` / projected `work_items`
- `POST /api/webhooks/github` → GitHub issue / pull request ingest
- `POST /api/webhooks/linear` → Linear issue ingest
- `GET /api/v1/health` → `${ORCHESTRATOR_BASE_URL}/api/v1/health` (legacy alias)

## Environment variables

- `PORT` (default: `3100`)
- `ORCHESTRATOR_BASE_URL` (default: `http://127.0.0.1:4000`)
- `LAUNCHER_BASE_URL` (default: `http://127.0.0.1:4100`)
- `ORCHESTRATOR_REQUEST_TIMEOUT_MS` (default: `15000`)
- `LAUNCHER_REQUEST_TIMEOUT_MS` (default: `15000`)
- `CORS_ORIGINS`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WORK_ITEM_DEFAULT_WORKSPACE_ID`
- `SETUP_DEFAULT_WORKSPACE_NAME` (default: `Personal Workspace`)
- `SETUP_DEFAULT_MANAGER_MODEL` (default: `openai/gpt-5.2`)
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_REPO_WORKSPACE_MAP` (JSON object mapping `owner/repo` → `workspace_id`)
- `LINEAR_WEBHOOK_SECRET`
- `LINEAR_API_KEY`
- `LINEAR_PROJECT_WORKSPACE_MAP` (JSON object mapping `project_id` → `workspace_id`)
- `LINEAR_TEAM_WORKSPACE_MAP` (JSON object mapping `team_id` → `workspace_id`)

## PL-4 ingest notes

- Manual web-client entry goes through `POST /api/work-items` and requires a Supabase bearer token for workspace membership validation.
- GitHub webhook normalization accepts `issues` and `pull_request` events, verifies `X-Hub-Signature-256`, and persists canonical `task` rows with `source='github'`.
- Linear webhook normalization accepts `Issue` events, verifies `Linear-Signature` on the raw body, enforces the one-minute timestamp replay window recommended by Linear, and persists canonical `task` rows with `source='linear'`.
- Existing Linear projects can be backfilled with `pnpm run backfill:linear-projects <project-id> [more-project-ids...]`.

## Tool naming

Database-backed agent tools exposed through this API follow the standard CRUD
shape: `resource.create`, `resource.read`, `resource.update`,
`resource.delete`, and `resource.list` for collection queries. Tool additions
must update contracts, API services, runtime registry, platform grant catalog,
restricted allowlists, tests, prompts, and schema/enum docs together.

See [../../docs/reference/tool-crud-conventions.md](../../docs/reference/tool-crud-conventions.md).

## Deployment

Public deployment infrastructure has not been published yet. See the
repository-level deployment note in `docs/deployment.md`.

## Development process

### Code review

When reviewing a PR, check the commit or PR metadata to identify which AI system authored the changes (e.g. Codex, Claude Code). When requesting changes, mention the appropriate system so it picks up the comment automatically:

- **Codex** — use `@codex` in your review comment so Codex is triggered to address the feedback.
- **Claude Code** — use `@claude` in your review comment so Claude Code is triggered to address the feedback.

This ensures the original authoring system sees the request and can iterate on the changes without manual hand-off.

## Run locally

```bash
cd express-server
cp .env.example .env
pnpm install
pnpm run dev
```

Then call:

```bash
curl http://localhost:3100/health
curl http://localhost:3100/api/v1/state
curl -X POST http://localhost:3100/api/v1/refresh
curl http://localhost:3100/api/v1/issues/MT-123
```
