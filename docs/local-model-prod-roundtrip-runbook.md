# Local Model Production Round-Trip Runbook

How to prove that a **locally running model** (e.g. Ollama on your laptop) is
serving an agent in the **production environment**: open the production web
app in a browser, pair your machine's `local-runtime-helper` with your
workspace, send a chat message to an agent bound to the local model, and
verify the message round-trips back to the browser.

This document is written so that an **agent** (or an engineer) can execute it
end to end. Every browser step has an API-level equivalent so the run can be
verified with `curl` even when UI details drift. The local-dev rehearsal in
the second half is the same flow against `./openmacaw run`, and was last
executed successfully on 2026-06-12 (see
[Verified local rehearsal](#verified-local-rehearsal)).

> Production hostnames are deliberately not written in this public repo (see
> [`open-source-readiness-scope.md`](open-source-readiness-scope.md)). Wherever
> you see `https://<app-domain>` / `wss://<app-domain>`, substitute your
> deployment's domain from the private infra repo.

## Read this first: the two local-model paths

There are **two distinct transports** for local models, and they are NOT
interchangeable. Knowing which one you're testing is the difference between a
meaningful pass and a false positive.

1. **Direct provider** (`runner_kind: local_model_coding`) — the orchestrator
   calls the OpenAI-compatible endpoint (Ollama) **itself** over HTTP
   ([`local_model_coding.ex`](../runtime/apps/orchestrator/lib/symphony_elixir/runner/local_model_coding.ex)
   → `ToolCallingLoop.run_direct`). This is what **gateway/browser chat**
   uses today
   ([`chat_runner.ex`](../runtime/apps/orchestrator/lib/symphony_elixir/gateway/chat_runner.ex)).
   It works when the orchestrator and the model share a network (local dev,
   or a model endpoint the cloud can reach). It **cannot** work from an AWS
   orchestrator to a model on your laptop.

2. **Helper relay** (`runner_kind: local_relay`) — the orchestrator sends
   protocol frames over the helper's outbound WebSocket
   (`wss://<app-domain>/local-relay/ws`), and the helper calls the local
   model ([`runner/local_relay.ex`](../runtime/apps/orchestrator/lib/symphony_elixir/runner/local_relay.ex),
   protocol spec in
   [`local-relay-protocol.md`](../runtime/docs/local-relay-protocol.md)).
   This is the only transport that can reach a laptop from AWS. It is used
   by the **work-item / agent-dispatch path** (`AgentRunner`).

**Known gap (as of 2026-06-12):** gateway chat does **not** traverse the
relay. `ChatRunner` only special-cases `local_model_coding`; a chat whose
routing rule resolves to `local_relay` silently falls through to the codex
runner ([`chat_runner.ex:31-40`](../runtime/apps/orchestrator/lib/symphony_elixir/gateway/chat_runner.ex)).
Until that is closed, the browser-chat-to-laptop-model round trip **through
the relay** does not exist in production; what you can verify in production
today is the relay *link* (helper online, heartbeats, events, test dispatch)
plus relay-dispatched agent work. Track related work in
[`local-model-connection-sanity-scope.md`](local-model-connection-sanity-scope.md).

The full production path under test, once chat rides the relay:

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

> Caveat: `test-dispatch` validates helper connectivity + advertised model
> and then calls the **orchestrator's** `/api/v1/local-runtime/health` —
> which requires a service-role bearer since the observability-API
> hardening. The platform currently calls it **unauthenticated**
> ([`local-runtime-machines.ts`](../platform/apps/api/src/services/local-runtime-machines.ts),
> `runRuntimeDiagnostics`), so a `dispatchSucceeded: false` here may be the
> 401, not a relay failure. Cross-check with the events endpoint and helper
> logs until that's fixed.

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

- `local_model_coding` → chat will hit the model endpoint **from the
  orchestrator**. In AWS this fails unless the cloud can reach the endpoint.
- `local_relay` → chat currently falls back to **codex** (the gap above). A
  successful reply does NOT prove the local model — check the proofs below.
- `local_runtime` → broken rule. The orchestrator rejects this alias
  (`{:runner_unsupported, "local_runtime"}` → codex fallback). The platform's
  registration service has written rules with this kind
  ([`registration.ts`](../platform/apps/api/src/services/local-runtime/registration.ts));
  delete/fix the rule before testing.

Then open the agent's chat and send:
`Reply with exactly the word PONG and nothing else. Do not use any tools.`

### Step 7 — Prove where the response came from

A reply alone proves nothing (codex fallback also replies). Verify at least
two of:

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

## Verified local rehearsal

Executed successfully on 2026-06-12 in a linked worktree. Differences from a
main-checkout run are called out inline.

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
`runner_kind: "local_model_coding"` (see "two paths" above; `local_relay`
and the broken `local_runtime` alias both end up at codex for chat). Inspect
via Supabase REST:

```bash
curl -s "$SUPABASE_URL/rest/v1/routing_rule?workspace_id=eq.<workspace-uuid>&select=id,name,runner_kind,provider,model,enabled" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" | jq
```

Watch out for **multiple enabled rules** for the same workspace — seed/test
data accumulates `local_runtime`-alias and stale machine-pinned rules that
win resolution and send chat to codex. Disable everything except the one
rule you intend to test.

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

This drives the same `/ws` gateway + `chat.send` the browser uses. With the
`local_model_coding` rule the verified result was: run resolved
`local_model_coding`, `ollama ps` showed `qwen3-coder:30b` loaded on GPU
during the run, and the assistant message `PONG` was persisted ~13s after
the user message. Note: the smoke's default `tool-call-round-trip` scenario
additionally asserts a tool call; with a no-tools prompt it exits non-zero
on that assertion even though the conversation reached `final` — for a chat
round trip, treat terminal state `final` + the proofs below as the pass
signal, or omit `--message` to let the default prompt exercise a tool call.

Proofs (same as production Step 7): `ollama ps` during the run; the
`message` table rows for the run
(`GET $SUPABASE_URL/rest/v1/message?run_id=eq.<run-id>&select=role,content`);
orchestrator log line `ChatRunner.dispatch … resolved_runner_kind="local_model_coding"`
(`runtime/apps/orchestrator/log/symphony.log.1`).

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
| Chat run times out, helper sees nothing | orchestrator log: `resolved_runner_kind` / `runner_unsupported` | Rule has `local_runtime` alias or `local_relay` (codex fallback) — set the rule to `local_model_coding` for chat |
| `rate_limited: a chat run is already active` | previous stuck run holds the session | Restart the orchestrator, or use a fresh `--session-key` |
| Chat replies but Ollama never loaded | `ollama ps`, helper logs | Codex/hosted fallback served it — fix the routing rule (Step/Section 4) |
| `invalid input syntax for type uuid` | smoke args | agent/workspace ids must be real UUIDs from the `agent` table |
| API exits with `ERR_MODULE_NOT_FOUND @harper/plan-schema` | workspace package dist | `cd platform/packages/plan-schema && pnpm run build` |
| First reply very slow | `ollama ps` | Cold model load (~tens of seconds for a 30B model) — expected once |

## Known gaps blocking the full prod round trip (2026-06-12)

1. **Gateway chat ignores `local_relay`** — `ChatRunner` falls back to codex;
   browser chat cannot reach a laptop model through the relay yet.
2. **Platform writes `runner_kind: "local_runtime"`** rules
   (`local-runtime/registration.ts` and friends) — an alias the orchestrator
   rejects, producing silent codex fallback.
3. **Platform `test-dispatch` calls the orchestrator health API without
   auth** — reports false negatives wherever the service role is configured
   (i.e. production).

## Related material

- [`platform/docs/reference/end-to-end-local-runbook.md`](../platform/docs/reference/end-to-end-local-runbook.md) — platform-only E2E (login, onboarding, chat)
- [`runtime/docs/local-relay-protocol.md`](../runtime/docs/local-relay-protocol.md) — relay wire protocol
- [`local-runtime-helper/docs/install.md`](../local-runtime-helper/docs/install.md) — helper install / launchd
- [`docs/local-model-connection-sanity-scope.md`](local-model-connection-sanity-scope.md) — in-flight UX/schema work on this flow
