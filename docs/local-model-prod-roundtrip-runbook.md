# Local Model Production Round-Trip Runbook

How to prove that a **locally running model** (e.g. Ollama on your laptop) is
serving an agent in the **production environment**: open the production web
app in a browser, pair your machine's `local-runtime-helper` with your
workspace, send a chat message to an agent bound to the local model, and
verify the message round-trips back to the browser.

This document is written so that an **agent** (or an engineer) can execute it
end to end. Every browser step has an API-level equivalent so the run can be
verified with `curl` even when UI details drift. The local-dev rehearsal in
the second half is the same flow against `./openmacaw run`, with notes from a
2026-06-12 run where behavior differs (see
[Local rehearsal](#local-rehearsal)).

> Production hostnames are deliberately not written in this public repo (see
> [`open-source-readiness-scope.md`](open-source-readiness-scope.md)). Wherever
> you see `https://<app-domain>` / `wss://<app-domain>`, substitute your
> deployment's domain from the private infra repo.

## Read this first: local runtime vs. local relay

There are two names in this flow that sound similar but refer to different
layers:

- `local_runtime_*` tables, routes, and helper commands describe the
  **registered local machine identity**: pairing tokens, machine presence,
  advertised helper capabilities, and setup UI.
- `runner_kind: local_relay` is the **execution runner kind** for registered
  local model chat. The orchestrator dispatches through the helper's outbound
  WebSocket, and the helper calls the local model.

The removed `runner_kind: local_runtime` alias should no longer appear in
routing rules. Migration `20260612120000_drop_local_runtime_runner_kind.sql`
rewrote those rows to `local_relay` and added a CHECK constraint to keep the
alias from coming back.

There are still two local-model execution paths. They are not
interchangeable, so knowing which one you're testing is the difference between
a meaningful pass and a false positive.

1. **Direct coding provider** (`runner_kind: local_model_coding`) — the
   orchestrator calls the OpenAI-compatible endpoint (Ollama) **itself** over HTTP
   ([`local_model_coding.ex`](../runtime/apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex)
   → `ToolCallingLoop.run_direct`). It works when the orchestrator and the
   model share a network (local dev, or a model endpoint the cloud can reach).
   It **cannot** work from an AWS orchestrator to a model on your laptop.

2. **Helper relay** (`runner_kind: local_relay`) — the orchestrator sends
   protocol frames over the helper's outbound WebSocket
   (`wss://<app-domain>/local-relay/ws`), and the helper calls the local
   model ([`runner/local_relay.ex`](../runtime/apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex),
   protocol spec in
   [`local-relay-protocol.md`](../runtime/docs/local-relay-protocol.md)).
   This is the only transport that can reach a laptop from AWS. Gateway chat
   and work-item / agent-dispatch both route `local_relay` profiles through
   this relay path.

Helper diagnostics use the helper-advertised runner kind, not the routing
runner kind. For example, a normal Ollama/OpenAI-compatible registration
stores `routing_rule.runner_kind = local_relay`, but diagnostics target
`target_runner_kind=openai_compatible`; OpenClaw registrations target
`openclaw`.

The full production path under test:

```
Browser (production web app)
  → platform API (ECS)            /ws gateway + REST
  → runtime orchestrator (ECS)
  → LocalRelay.Registry → helper WebSocket session
  → local-runtime-helper (Go daemon on YOUR machine, outbound wss)
  → Ollama (http://127.0.0.1:11434/v1)
  → FinalFrame back over the same WebSocket → orchestrator → browser
```

## Prerequisites

On the **local machine** (the one that will serve the model):

- Ollama running with the model you intend to use pulled:
  `curl -s http://127.0.0.1:11434/api/tags`
- The helper built:
  `cd local-runtime-helper && go build -o ~/.local/bin/local-runtime-helper ./cmd/local-runtime-helper`
- Outbound HTTPS/WSS to the production domain.

On the **production side**: a healthy deploy (image SHA matches
`git rev-parse origin/main`), a user account, a workspace, and a dedicated
test agent.

For API checks, export:

```bash
export APP=https://<app-domain>
export TOKEN=<access-token>          # from the browser session / auth state
export WORKSPACE_ID=<workspace-uuid>
```

## Production procedure

### Step 1 — Open the app and sign in

Browse to `https://<app-domain>`, sign in, confirm `GET /api/auth/state`
succeeds (network tab), note workspace id and test agent id.

### Step 2 — Mint a pairing token

**Settings → Local runtimes** (`/settings/local-runtimes`) → **Register local
runtime**. The card shows the workspace id and a one-time `lrh_…` token
(minted via `POST /api/local-runtime/runtimes?workspaceId=…`; rotate later
with `POST …/runtimes/<machineId>/rotate-token`).

### Step 3 — Register and start the helper

```bash
local-runtime-helper register \
  --endpoint "wss://<app-domain>" \
  --workspace "$WORKSPACE_ID" \
  --name "$(hostname -s)" \
  --token "lrh_…" \
  --openai-compatible-endpoint "http://127.0.0.1:11434/v1" \
  --openai-compatible-model "<model-from-ollama-tags>"
local-runtime-helper doctor
local-runtime-helper start    # add --log-level debug while testing
```

The endpoint may be a bare host (the helper appends `/local-relay/ws`) or a
full path like `…/worker-bridge/relay/ws`
([`client.go`](../local-runtime-helper/internal/relay/client.go)). Expect in
the logs: `registered runner kind=openai_compatible model=…`, then
`registered with relay machine_id=…`, then heartbeats every ~30s.

### Step 4 — Verify the machine is online

Settings → Local runtimes should show the machine **online** with the
advertised runner and model.

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$APP/api/local-runtime/runtimes?workspaceId=$WORKSPACE_ID" | jq
export MACHINE_ID=<machine-id-from-response>
```

### Step 5 — Test dispatch and event log

Use the doctor panel's **Run test dispatch**, or:

```bash
curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  "$APP/api/local-runtime/runtimes/$MACHINE_ID/test-dispatch?workspaceId=$WORKSPACE_ID" -d '{}' | jq
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$APP/api/local-runtime/runtimes/$MACHINE_ID/events?workspaceId=$WORKSPACE_ID&limit=20" | jq
```

`test-dispatch` validates helper connectivity + advertised model and then
calls the orchestrator's protected `/api/v1/local-runtime/health` endpoint
with the platform service-role bearer. A successful result should show
`helperConnected: true`, `modelAdvertised: true`, and
`dispatchSucceeded: true`. If it fails, cross-check the events endpoint and
helper logs to separate service configuration from relay/model issues.

### Step 6 — Bind the agent and send a message

Bind the test agent to the local model (agent page model policy, or
`POST /api/agents/$AGENT_ID/assign-local-model?workspaceId=…` with
`{"machineId": "$MACHINE_ID"}`), then confirm what actually resolved:

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$APP/api/diagnostic/agents/$AGENT_ID?workspaceId=$WORKSPACE_ID" | jq
```

**Check the resolved `runner_kind` in the diagnostic output — this decides
what your chat test means:**

- `local_relay` → chat dispatches through the helper relay. This is the
  expected production path for a laptop-hosted model.
- `local_model_coding` → chat will hit the model endpoint **from the
  orchestrator**. In AWS this fails unless the cloud can reach the endpoint,
  so it is usually a local-dev or cloud-reachable-endpoint path.

(Historical note: registration used to write a `local_runtime` alias the
orchestrator rejected the same way. Migration
`20260612120000_drop_local_runtime_runner_kind.sql` rewrote those rows to
`local_relay` and a CHECK constraint now blocks the alias, so it should no
longer appear here.)

Then open the agent's chat and send:
`Reply with exactly the word PONG and nothing else. Do not use any tools.`

### Step 7 — Prove where the response came from

A reply alone proves nothing if fallback routing is configured. Verify at
least two of:

1. **Ollama** (local machine): `ollama ps` shows the model loaded with a
   fresh "until" window covering your message time.
2. **Helper logs**: a dispatch for your message (relay path only). If the
   helper saw nothing and Ollama served the request, the orchestrator went
   direct (`local_model_coding`) — fine locally, a misconfiguration signal
   in prod.
3. **Events endpoint** (Step 5): dispatch events correlated with the message
   time.
4. **Negative control**: stop Ollama (or the helper, for the relay path),
   resend, and confirm the chat surfaces a deterministic error. If you get a
   fluent answer with the model stack down, a hosted model served it — the
   binding is wrong. Restart and confirm recovery.

### Pass / fail

Pass requires: machine **online** (Step 4), event log shows the helper's
register/heartbeat lifecycle (Step 5), chat returns the expected reply
(Step 6), and at least two Step 7 proofs — including the negative control if
you can tolerate the brief outage. Anything else is a fail; capture helper
logs, the events output, and the agent diagnostic JSON.

## Local rehearsal

Run this in a local or linked worktree to rehearse the production path.
Differences observed during a 2026-06-12 linked-worktree run are called out
inline.

### 1. One-time worktree setup

```bash
# env files are gitignored; copy from the main checkout
cp <main>/platform/.env platform/.env
cp <main>/platform/apps/api/.env platform/apps/api/.env
cp <main>/platform/apps/web/.env.local platform/apps/web/.env.local
cp <main>/runtime/apps/orchestrator/.env runtime/apps/orchestrator/.env  # SUPABASE_URL + SERVICE_ROLE_KEY — required for relay auth

# workspace packages need dist/ before the API can boot
cd platform/packages/plan-schema && pnpm run build
```

### 2. Start everything

```bash
OPENMACAW_HEALTH_TIMEOUT=240 ./openmacaw run   # first boot compiles Elixir; 60s default is too short
./openmacaw status
```

In the main worktree the ports are web 5173 / api 3100 / orchestrator 4000 /
launcher 4100; linked worktrees get hash-offset ports — read them from the
`run` output (this rehearsal got 5208/3135/4035/4135).

Ollama must be running with the model from
[`dev-runtime.toml`](../local-runtime-helper/dev-runtime.toml)
(`qwen3-coder:30b`): `curl -s http://127.0.0.1:11434/api/tags`.

### 3. Start the helper

The helper's workspace id must match the agent's workspace (a real UUID from
the `agent` table — `dev-workspace` from the checked-in dev config only works
if your agent lives there). Override the endpoint for offset ports:

```bash
cd local-runtime-helper
LOCAL_RUNTIME_ENDPOINT=ws://127.0.0.1:<orch-port> \
  go run ./cmd/local-runtime-helper start --config ./dev-runtime.toml --log-level debug
```

Expect `registered with relay machine_id=…`. Verify from the orchestrator
side (service-role bearer required):

```bash
curl -s "http://127.0.0.1:<orch-port>/api/v1/local-runtime/health?workspace_id=<workspace-uuid>&target_runner_kind=openai_compatible" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq
# → status "healthy", reason "ready", your machine listed
```

### 4. Check the agent's routing rule

The chat round trip needs the agent's matched `routing_rule` to have
`runner_kind: "local_relay"` for the helper-relay path, or
`runner_kind: "local_model_coding"` only when intentionally testing the direct
provider path. Inspect via Supabase REST:

```bash
curl -s "$SUPABASE_URL/rest/v1/routing_rule?workspace_id=eq.<workspace-uuid>&select=id,name,runner_kind,provider,model,enabled" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq
```

Watch out for **multiple enabled rules** for the same workspace — seed/test
data can accumulate stale machine-pinned rules that win resolution. Disable
everything except the one rule you intend to test.

### 5. Round trip via the gateway (browser-equivalent)

```bash
cd runtime
set -a && . ./apps/orchestrator/.env && set +a   # smoke needs SUPABASE_SERVICE_ROLE_KEY for the health probe
pnpm run smoke:local-relay-conversation -- \
  --workspace-id <workspace-uuid> --agent-id <agent-uuid> \
  --helper real --orchestrator-url http://127.0.0.1:<orch-port> \
  --timeout-ms 240000 \
  --message "Reply with exactly the word PONG and nothing else. Do not use any tools."
```

This drives the same `/ws` gateway + `chat.send` the browser uses. For the
production-equivalent relay path, the run should resolve `local_relay`, the
helper logs should show a dispatch for the message, `ollama ps` should show
`qwen3-coder:30b` loaded, and the assistant message should be persisted after
the run reaches `final`. Note: the smoke's default `tool-call-round-trip` scenario
additionally asserts a tool call; with a no-tools prompt it exits non-zero
on that assertion even though the conversation reached `final` — for a chat
round trip, treat terminal state `final` + the proofs below as the pass
signal, or omit `--message` to let the default prompt exercise a tool call.

Proofs (same as production Step 7): `ollama ps` during the run; the
`message` table rows for the run
(`GET $SUPABASE_URL/rest/v1/message?run_id=eq.<run-id>&select=role,content`);
orchestrator log line `ChatRunner.dispatch … resolved_runner_kind="local_relay"`
for relay, or `resolved_runner_kind="local_model_coding"` for the direct
provider path (`runtime/apps/orchestrator/log/symphony.log.1`).

Or do it in the actual browser: open `http://127.0.0.1:<web-port>`, log in
with the dev credentials (`VITE_DEV_LOGIN_EMAIL` / `VITE_DEV_LOGIN_PASSWORD`
in `platform/apps/web/.env.local`), open the bound agent's chat, send the
PONG prompt, and run the same proofs.

### 6. Relay-link verification (the prod-critical leg)

With the helper running, the relay link itself is verified by: the
orchestrator health endpoint above (`status: healthy`, your machine online),
helper heartbeat logs, and a clean reconnect cycle when you restart the
orchestrator (the helper redials with backoff — watch
`relay connection lost, reconnecting` → `registered with relay`).

## Troubleshooting

| Symptom | Check | Likely fix |
|---|---|---|
| Helper won't connect | `local-runtime-helper doctor`; dial errors in logs | Wrong scheme (`wss://` prod, `ws://` dev), wrong port (orchestrator, not API), or consumed/rotated token |
| Orchestrator APIs return `service_role_unconfigured` (503) | orchestrator env | `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` not in `runtime/apps/orchestrator/.env`; **a restart only helps if the old beam process actually died — check `lsof -iTCP:<port>`** |
| Orchestrator APIs return 401 | caller | Send `Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY` |
| Chat run times out, helper sees nothing | orchestrator log: `resolved_runner_kind`; helper logs | If the rule resolved `local_model_coding`, the run is using the direct path. For a laptop-hosted production model, bind the agent to the registered `local_relay` rule. |
| `rate_limited: a chat run is already active` | previous stuck run holds the session | Restart the orchestrator, or use a fresh `--session-key` |
| Chat replies but Ollama never loaded | `ollama ps`, helper logs | A hosted fallback likely served it — fix the routing rule (Step/Section 4) |
| `invalid input syntax for type uuid` | smoke args | agent/workspace ids must be real UUIDs from the `agent` table |
| API exits with `ERR_MODULE_NOT_FOUND @harper/plan-schema` | workspace package dist | `cd platform/packages/plan-schema && pnpm run build` |
| First reply very slow | `ollama ps` | Cold model load (~tens of seconds for a 30B model) — expected once |

## Recently resolved production gaps (2026-06-12)

- Gateway chat for `local_relay` agents now runs through `Runner.LocalRelay`
  instead of falling through to Codex.
- Platform local-runtime diagnostics now send the required service-role bearer
  to protected orchestrator observability endpoints.
- The unsupported `runner_kind: "local_runtime"` alias was removed. The
  `local_runtime_*` tables and routes still name the local machine
  registration domain, but registered local model execution uses
  `runner_kind: "local_relay"`.

## Related material

- [`platform/docs/reference/end-to-end-local-runbook.md`](../platform/docs/reference/end-to-end-local-runbook.md) — platform-only E2E (login, onboarding, chat)
- [`runtime/docs/local-relay-protocol.md`](../runtime/docs/local-relay-protocol.md) — relay wire protocol
- [`local-runtime-helper/docs/install.md`](../local-runtime-helper/docs/install.md) — helper install / launchd
- [`docs/local-model-connection-sanity-scope.md`](local-model-connection-sanity-scope.md) — in-flight UX/schema work on this flow
