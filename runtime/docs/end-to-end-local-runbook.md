# End-to-End Local Runbook

This runbook is the repository-scoped version of the local end-to-end guide for `parallel-agent-runtime`.
It is written for the code and scripts that exist in this repo today:

- root `package.json` scripts
- `apps/orchestrator` Elixir runtime
- launcher-hosted `worker-bridge`
- API push tracker at `POST /api/v1/items`
- live Linear + Codex end-to-end test in `apps/orchestrator/test/symphony_elixir/live_e2e_test.exs`

Use this when you want to prove the local stack works before touching AWS, the platform API server, or a deployed environment.

## What “end-to-end” means in this repo

There are two useful local paths:

1. `Launcher -> Orchestrator -> API tracker -> Codex worker`
   This is the fastest local smoke test. It proves the local runtime can accept work, create a workspace, run Codex, and expose runtime state over HTTP.
2. `Linear -> Orchestrator -> Codex worker -> Linear completion`
   This is the full live end-to-end path. It uses real external services and is the only local path here that proves tracker polling and terminal-state cleanup against a real tracker.

There is also a smaller `worker-bridge` sanity check that validates launcher-side worker spawning without involving orchestrator dispatch.

## Option D: Ollama/Qwen local model smoke

Use this PR8 harness when validating first-class local model support for an
OpenAI-compatible endpoint such as Ollama, vLLM, or LM Studio.

In this repository today, the checked-in harness proves the local model and
runtime normalization portion of the flow:

```text
Ollama OpenAI-compatible endpoint
  -> SymphonyElixir.Provider.OpenAICompatible
  -> normalized message.delta and run.completed events
```

When a relay helper implementation is available, the same wrapper can also
start that helper and the local runtime stack before running the assertion. The
full target flow remains:

```text
platform routing / execution profile
  -> runtime local_relay dispatch
  -> local helper
  -> Ollama /v1/chat/completions
  -> runtime normalized events
  -> platform event boundary
```

### Prerequisites

- Ollama installed locally.
- `qwen2.5-coder:latest`, or another model set through `OLLAMA_MODEL`.
- Elixir dependencies installed for `apps/orchestrator`.

### Run the default smoke

From the repo root:

```bash
pnpm run smoke:local-ollama-qwen
```

The wrapper:

1. Reuses an existing Ollama server at `http://127.0.0.1:11434`, or starts
   `ollama serve` if the CLI is available.
2. Pulls `qwen2.5-coder:latest` unless `SKIP_OLLAMA_PULL=1`.
3. Runs `mix local_model.smoke` against Ollama's OpenAI-compatible
   `/v1/chat/completions` endpoint.
4. Fails unless the response produces non-empty text plus normalized
   `message.delta` and `run.completed` events.

Useful overrides:

```bash
OLLAMA_MODEL=qwen2.5-coder:latest \
OLLAMA_HOST=http://127.0.0.1:11434 \
pnpm run smoke:local-ollama-qwen
```

You can also run the assertion directly from the orchestrator app:

```bash
cd apps/orchestrator
mix local_model.smoke \
  --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5-coder:latest \
  --api-key ollama
```

### Include the local helper and runtime stack

Once the `local-runtime-helper` repo or binary is available, provide its startup
command to the wrapper:

```bash
LOCAL_RUNTIME_HELPER_COMMAND='/path/to/local-runtime-helper --config ./helper.toml' \
LOCAL_RUNTIME_HELPER_HEALTH_URL=http://127.0.0.1:4150/health \
START_LOCAL_RUNTIME=1 \
pnpm run smoke:local-ollama-qwen
```

`START_LOCAL_RUNTIME=1` starts the existing launcher/orchestrator wrapper before
the provider assertion. The helper command is optional because this runtime repo
does not currently include the helper daemon from PR3/PR4.

### Success criteria

- Ollama accepts a chat completion for the selected model.
- The runtime OpenAI-compatible adapter returns provider
  `openai_compatible`.
- The smoke summary includes normalized `message.delta` and `run.completed`
  event names.
- No output includes local API keys or bearer tokens.

## Prerequisites

From your local clone of this repository:

```bash
cd /path/to/parallel-agent-runtime
```

Required for all local paths:

- `mise` installed and available on `PATH`
- Erlang/Elixir installed via `mise install`
- `codex` available on `PATH`
- Codex auth present at `~/.codex/auth.json`

Recommended bootstrap:

```bash
mise install
cd apps/orchestrator
mise exec -- mix setup
cd ../..
```

The root `pnpm` scripts load `./.env` automatically when present, so keep repo-specific local env there if needed.

## Option A: Fast local end-to-end run

This is the default inner-loop path in this repo.

It exercises:

- launcher startup on `:4100`
- orchestrator startup on `:4000`
- API tracker ingestion via `POST /api/v1/items`
- workspace creation under `/tmp/symphony-local-e2e`
- real Codex session startup
- runtime state and dashboard endpoints

It does not exercise real Linear behavior.

### 1. Start the local runtime stack

From the repo root:

```bash
pnpm run start:local
```

This wrapper starts:

- launcher on `:4100`
- direct orchestrator on `:4000` using `apps/orchestrator/WORKFLOW.local-e2e.md`

It waits for both health endpoints before reporting ready and writes logs to:

- `.run-logs/launcher.log`
- `.run-logs/orchestrator.log`

Use environment variables to override the defaults:

```bash
LAUNCHER_PORT=4100 ORCHESTRATOR_PORT=4000 WORKFLOW_PATH=./WORKFLOW.local-e2e.md pnpm run start:local
```

Sanity checks:

```bash
curl http://127.0.0.1:4100/health
curl http://127.0.0.1:4000/api/v1/health
```

For local-relay testing that should keep running across terminals, use detached
mode on the existing local-relay startup command. It starts the launcher, the
local-relay workflow orchestrator, and the sibling `../local-runtime-helper`
daemon by default:

```bash
pnpm run start:local-relay -- --detached
pnpm run start:local-relay -- --status
pnpm run smoke:local-relay -- --workspace-id dev-workspace --target-runner-kind openai_compatible --model qwen3-coder:30b
pnpm run start:local-relay -- --stop
```

Override `LOCAL_RUNTIME_HELPER_DIR`, `LOCAL_RUNTIME_HELPER_CONFIG`, or
`START_HELPER=0` when the helper repo/config lives elsewhere or is already
managed separately.

### 2. Push a work item into the API tracker

In another terminal:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/items \
  -H 'content-type: application/json' \
  -d '{
    "id": "ISSUE-1",
    "title": "Local runtime smoke test",
    "description": "Create LOCAL_E2E_RESULT.txt in the workspace."
  }'
```

Expected result:

- `201 Created`
- JSON body includes the accepted item identifier

### 3. Verify the run

Check runtime state:

```bash
curl http://127.0.0.1:4000/api/v1/state
```

Open the dashboard if you want the visual view:

- [Launcher health](http://127.0.0.1:4100/health)
- [Orchestrator dashboard](http://127.0.0.1:4000)

Check the proof file:

```bash
find /tmp/symphony-local-e2e -name LOCAL_E2E_RESULT.txt -print
```

Inspect it:

```bash
cat /tmp/symphony-local-e2e/*/LOCAL_E2E_RESULT.txt
```

Success criteria:

- the item appears in runtime state
- a workspace directory was created below `/tmp/symphony-local-e2e`
- `LOCAL_E2E_RESULT.txt` exists
- the file contains the issue identifier text

### Manual split-terminal startup

Use this only when you need to debug launcher and orchestrator startup separately.

In one terminal:

```bash
pnpm run start:launcher
```

In another terminal:

```bash
WORKFLOW_PATH=./WORKFLOW.local-e2e.md pnpm run start:orchestrator
```

Then verify:

```bash
curl http://127.0.0.1:4100/health
curl http://127.0.0.1:4000/api/v1/health
```

### Launcher-created orchestrators

The launcher API can register orchestrator instances, but local process-level validation should use the direct orchestrator listener above. The direct listener is what the platform local runbook expects at `ORCHESTRATOR_BASE_URL=http://127.0.0.1:4000`.

### 4. Clean up

Stop `pnpm run start:local` with Ctrl+C.

If you want to remove the local workspaces too:

```bash
rm -rf /tmp/symphony-local-e2e
```

## Option B: Direct orchestrator run with the checked-in local workflow

Use this when you want to debug the runtime without going through the launcher or wrapper.

This repo already includes [`apps/orchestrator/WORKFLOW.local-e2e.md`](../apps/orchestrator/WORKFLOW.local-e2e.md), which is configured for:

- `tracker.kind: api`
- workspace root `/tmp/symphony-local-e2e`
- one Codex turn
- proof file `LOCAL_E2E_RESULT.txt`

Run it from the repo root:

```bash
WORKFLOW_PATH=./WORKFLOW.local-e2e.md pnpm run start:orchestrator
```

Then push work directly:

```bash
curl -X POST http://127.0.0.1:4000/api/v1/items \
  -H 'content-type: application/json' \
  -d '{
    "id": "ISSUE-2",
    "title": "Direct orchestrator smoke test",
    "description": "Create LOCAL_E2E_RESULT.txt in the workspace."
  }'
```

Use this path when the launcher is not the thing you are debugging.

## Option C: Live end-to-end with Linear

Use this only when you need the real tracker path.

It exercises:

- Linear GraphQL queries and mutations
- orchestrator polling against a real tracker
- Codex app-server lifecycle
- issue completion behavior
- workspace side effects and terminal-state cleanup
- local and SSH worker variants in the live test

### Prerequisites

- valid `LINEAR_API_KEY`
- a Linear team with key `SYME2E`, or set `SYMPHONY_LIVE_LINEAR_TEAM_KEY`
- Codex auth and quota available
- Docker available if you want the SSH-worker path to fall back to local containers

### Run the live test

From the repo root:

```bash
export LINEAR_API_KEY=lin_api_...
export SYMPHONY_RUN_LIVE_E2E=1
pnpm run test:e2e
```

What the test does:

1. Queries the Linear team and workflow states.
2. Creates a temporary project.
3. Creates a temporary issue.
4. Starts the orchestrator against that project.
5. Waits for the issue to be claimed and processed.
6. Verifies `LIVE_E2E_RESULT.txt` exists as proof of workspace side effects.
7. Verifies the issue gets commented on and moved to a terminal state.
8. Completes the temporary Linear project.

Source of truth for this flow:

- [`apps/orchestrator/test/symphony_elixir/live_e2e_test.exs`](../apps/orchestrator/test/symphony_elixir/live_e2e_test.exs)

Use this path before merge when changing tracker behavior, worker execution, or cleanup logic.

## Worker-bridge sanity check

Use this when you only need to prove the launcher can spawn a worker session with scoped credentials.

Start the launcher:

```bash
pnpm run start:launcher
```

List sessions:

```bash
curl http://127.0.0.1:4100/worker-bridge/sessions
```

Start a worker:

```bash
mkdir -p /tmp/symphony-worker-bridge-smoke

curl -X POST http://127.0.0.1:4100/worker-bridge/sessions \
  -H 'content-type: application/json' \
  -d '{
    "kind": "codex",
    "cwd": "/tmp/symphony-worker-bridge-smoke",
    "credentials": {
      "OPENAI_API_KEY": {
        "source": "env",
        "name": "OPENAI_API_KEY"
      }
    }
  }'
```

This validates launcher-side process startup, but it does not prove orchestrator dispatch or tracker flow.

## Common failure modes

### `codex` fails to start

Check:

- `which codex`
- `cat ~/.codex/auth.json`
- `echo $OPENAI_API_KEY` if the chosen path depends on env credentials

### Ports `4000` or `4100` are already in use

The direct orchestrator wrapper already frees its target port, but launcher does not. Inspect and stop the conflicting process:

```bash
lsof -i :4000
lsof -i :4100
```

### Item accepted but no proof file appears

Check:

- orchestrator state at `GET /api/v1/state`
- dashboard at `http://127.0.0.1:4000`
- launcher or orchestrator terminal logs
- whether the workspace root exists and is writable

### Live test is skipped

That is expected unless:

```bash
export SYMPHONY_RUN_LIVE_E2E=1
```

The live test module explicitly skips otherwise.

## Recommended usage

- Use Option A for day-to-day local validation.
- Use Option B when isolating runtime issues from launcher behavior.
- Use the worker-bridge check when debugging launcher-side spawning only.
- Use Option C before merge when you changed real tracker integration or cleanup behavior.

## Related files

- [`docs/local-e2e-testing.md`](./local-e2e-testing.md) for the existing testing guide
- [`apps/orchestrator/README.md`](../apps/orchestrator/README.md) for runtime configuration
- [`apps/orchestrator/docs/worker-bridge.md`](../apps/orchestrator/docs/worker-bridge.md) for launcher worker-bridge details
- [`scripts/start-orchestrator.sh`](../scripts/start-orchestrator.sh) for the direct local startup wrapper
