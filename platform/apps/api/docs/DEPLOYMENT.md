# Deployment

## Build

```bash
pnpm run build
```

This compiles TypeScript to JavaScript in `dist/`. The output is ES module format.

Verify the build:

```bash
node dist/index.js
# Should print: symphony-express-server listening on http://localhost:3100
```

## Production Start

```bash
NODE_ENV=production node dist/index.js
```

Required environment variables (set in your deployment platform):

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default: 3100) | Server listen port |
| `ORCHESTRATOR_BASE_URL` | Yes | Full URL to orchestrator API |
| `ORCHESTRATOR_REQUEST_TIMEOUT_MS` | No (default: 15000) | Timeout in ms |
| `CONTAINER_EXECUTION_ROUTING_MODE` | No (default: `local_helper_default`) | Container rollout stage: `local_helper_default`, `allowlist`, `percentage`, or `container_default` |
| `CONTAINER_EXECUTION_ALLOWLIST_WORKSPACE_IDS` | No | Comma-separated workspace IDs always routed to container execution in allowlist/percentage modes |
| `CONTAINER_EXECUTION_ROLLOUT_PERCENTAGE` | No (default: 0) | Percentage of non-allowlisted workspaces routed to containers in `percentage` mode |

Set `CONTAINER_EXECUTION_ROUTING_MODE=local_helper_default` to roll container
coding traffic back to the local-helper path without a data migration.

## Docker

### Dockerfile

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm run build

FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN pnpm install --frozen-lockfile --omit=dev
COPY --from=builder /app/dist/ dist/
ENV NODE_ENV=production
EXPOSE 3100
CMD ["node", "dist/index.js"]
```

### Build and Run

```bash
docker build -t symphony-server .
docker run -p 3100:3100 \
  -e ORCHESTRATOR_BASE_URL=http://host.docker.internal:4000 \
  symphony-server
```

## Pre-Deploy Checklist

1. [ ] `pnpm run validate` passes (lint + format + typecheck + test)
2. [ ] `pnpm run build` succeeds
3. [ ] Built server starts and responds to `/health`
4. [ ] Environment variables are set in the deployment target
5. [ ] PR is approved and merged to `main`

## Post-Deploy Verification

```bash
# 1. Health check
curl https://<deployed-url>/health
# Expect: { "ok": true, "service": "symphony-express-server", ... }

# 2. Upstream connectivity
curl https://<deployed-url>/api/v1/health
# Expect: 200 with orchestrator health data

# 3. Functional check
curl https://<deployed-url>/api/v1/state
# Expect: 200 with state data
```

## Rollback

If the deploy is broken:

1. Revert to the previous working commit on `main`.
2. Rebuild and redeploy from that commit.
3. Verify `/health` returns `ok: true`.
4. Investigate the failure on a branch before re-attempting.

## Health Check Endpoint for Load Balancers

Configure your load balancer or orchestration platform to poll:

- **Path**: `/health`
- **Method**: GET
- **Success**: HTTP 200 with `{ "ok": true }`
- **Failure**: HTTP 503 (upstream down) or no response (server down)
- **Interval**: 10-30 seconds
- **Timeout**: 5 seconds
