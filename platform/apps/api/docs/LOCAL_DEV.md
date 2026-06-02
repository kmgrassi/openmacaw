# Local Development

## Prerequisites

- **Node.js >= 20** (check with `node -v`)
- **pnpm** (comes with Node.js)
- Access to the orchestrator API (Elixir backend) on `localhost:4000`, or willingness to work with the server returning 502s for proxy routes.

## First-Time Setup

```bash
# 1. Clone and enter the repo
cd symphony-server

# 2. Copy environment config
cp .env.example .env

# 3. Install dependencies
pnpm install

# 4. Start the dev server (hot reload)
pnpm run dev
```

The server starts on `http://localhost:3100`.

## Available Scripts

| Command | What it does |
|---------|-------------|
| `pnpm run dev` | Start with hot reload (tsx watch) |
| `pnpm run local` | Start once without watch |
| `pnpm run build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled JS from `dist/` |
| `pnpm run lint` | Run ESLint |
| `pnpm run lint:fix` | Run ESLint with auto-fix |
| `pnpm run format` | Format code with Prettier |
| `pnpm run format:check` | Check formatting without writing |
| `pnpm run typecheck` | Run TypeScript compiler (no emit) |
| `pnpm test` | Run Vitest test suite |
| `pnpm run validate` | Run all checks (lint + format + typecheck + test) |

## Verifying It Works

```bash
# Health check (always works, even without orchestrator)
curl http://localhost:3100/health

# If orchestrator is running on :4000
curl http://localhost:3100/api/v1/health
curl http://localhost:3100/api/v1/state
```

## Environment Variables

Edit `.env` to configure:

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `3100` | Change if port is taken |
| `ORCHESTRATOR_BASE_URL` | `http://127.0.0.1:4000` | Point to your orchestrator instance |
| `ORCHESTRATOR_REQUEST_TIMEOUT_MS` | `15000` | Increase for slow networks |

## Working Without the Orchestrator

If you don't have the orchestrator running locally:

- `/health` will return `{ ok: false }` with a 503 status.
- Proxy routes (`/api/v1/*`) will return 502 errors.
- This is fine for working on non-proxy features (middleware, validation, etc.).

## Debugging

### With VS Code

Add to `.vscode/launch.json`:

```json
{
  "type": "node",
  "request": "launch",
  "name": "Dev Server",
  "runtimeExecutable": "pnpm exec",
  "runtimeArgs": ["tsx", "src/index.ts"],
  "envFile": "${workspaceFolder}/.env",
  "console": "integratedTerminal"
}
```

### With console.log

Standard `console.log` works. The server logs startup info by default.

### Inspecting Proxy Requests

To see what's going to the orchestrator, temporarily add logging in `orchestratorRequest()`:

```typescript
console.log(`[proxy] ${init?.method ?? "GET"} ${ORCHESTRATOR_BASE_URL}${path}`);
```

Remove before committing.
