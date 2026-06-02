# Local Model End-to-End: Scope & Status

Goal: route an agent to a local model (Ollama) through the existing
`Runner.LocalRelay` → `local-runtime-helper` → `Provider.OpenAICompatible`
path, running entirely on the local machine.

## Architecture

```text
Platform (web + API)
  -> ExecutionProfileResolver
  -> runner_kind: local_relay, target_runner_kind: openai_compatible
  -> runtime orchestrator (port 4000)
  -> Runner.LocalRelay dispatches over relay WebSocket
  -> local-runtime-helper daemon (connects outbound WSS to runtime)
  -> OpenAI-compatible runner
  -> Ollama http://127.0.0.1:11434/v1/chat/completions
  -> response frames back through relay
  -> runtime normalizes to message.delta / run.completed events
  -> platform receives normalized events
```

## Current State by Repository

### parallel-agent-runtime (on `main`) — DONE

All relay infrastructure is merged:

| Module | File | Status |
|---|---|---|
| Runner.LocalRelay | `lib/symphony_elixir/runner/local_relay.ex` | Merged (PR #134) |
| LocalRelay.Registry | `lib/symphony_elixir/local_relay/registry.ex` | Merged (PR #134) |
| LocalRelay.Presence | `lib/symphony_elixir/local_relay/presence.ex` | Merged (PR #133) |
| LocalRelay.TokenValidator | `lib/symphony_elixir/local_relay/token_validator.ex` | Merged (PR #133) |
| LocalRelaySocket (WS endpoint) | `lib/symphony_elixir_web/local_relay_socket.ex` | Merged (PR #133) |
| Provider.OpenAICompatible | `lib/symphony_elixir/provider/openai_compatible.ex` | Merged |
| LocalRuntime.Capabilities | `lib/symphony_elixir/local_runtime/capabilities.ex` | Merged (PR #131) |
| LocalRuntime.Diagnostics | `lib/symphony_elixir/local_runtime/diagnostics.ex` | Merged (PR #132) |
| Dispatch hardening | (across relay modules) | Merged (PR #135) |
| Smoke harness (Ollama) | `lib/symphony_elixir/local_model_smoke.ex` | Merged (PR #130) |
| Runner.resolve "local_relay" | `lib/symphony_elixir/runner.ex` | Merged |
| Relay protocol spec | `docs/local-relay-protocol.md` + `.schema.json` | Merged |

Runner.resolve maps `"local_relay"` → `SymphonyElixir.Runner.LocalRelay`.
The runner dispatches via the Registry, which finds online helpers by
`(workspace_id, target_runner_kind)`.

Token validation currently reads from a `local_runtime_token` table.
**That table does not exist in the platform database yet** — this is the
primary blocker for authenticated relay connections.

### local-runtime-helper (on `main`) — PARTIALLY DONE

| Component | Status |
|---|---|
| Config parser (`runtime.toml`) | Merged (PR #5) |
| Protocol wire frames (9 types) | Merged (PR #3) |
| Register command CLI | Merged (PR #4) |
| OpenAI-compatible runner | Merged (PR #8) |
| Relay WebSocket client loop | **Open PR #9** — `codex/pr-7-dispatch-runner-wiring` |
| Install ergonomics (status, doctor, logout) | **Open PR #10** — `codex/helper-pr8-install-ergonomics` |
| Diagnostics event envelopes | **Open PR #11** — `codex/pr-9-diagnostics-events` |

**The critical missing piece is PR #9** — the relay client loop that connects
to the runtime's WSS endpoint, authenticates, receives dispatch frames, routes
them to the OpenAI-compatible runner, and sends back progress/output/complete
frames.

### parallel-agent-platform (on `main`) — NOT STARTED

None of the local-model-specific platform work has begun:

| PR (from plan) | What | Status |
|---|---|---|
| PR1 | `local_runtime_machine` + `local_runtime_token` DB migration | Not started |
| PR2 | Runtime token CRUD API (`/api/runtime-tokens`) | Not started |
| PR8 | Capability probe API + persistence | Not started |
| PR9 | ExecutionProfileResolver local model routing | Not started |
| PR10 | Local runtime settings UI | Not started |

## Blockers for End-to-End Local Run

### Hard blockers (must solve)

1. **Platform DB migration (PR1)** — The runtime's `TokenValidator` reads
   `local_runtime_token` from the database. Without the table, no helper can
   authenticate to the relay socket. Either:
   - (a) Create the migration, or
   - (b) Add a dev-mode bypass: skip token validation when running locally
     with an env flag like `LOCAL_RELAY_DEV_MODE=1`.

2. **Helper relay client loop (PR #9)** — The helper can parse config and run
   the OpenAI-compatible runner, but cannot connect to the runtime relay
   socket yet. This PR wires the WebSocket client, frame dispatch, and
   response forwarding.

3. **Execution profile routing** — There needs to be a way to tell the
   orchestrator "use `local_relay` runner for this work item." Currently
   the execution profile is resolved from runner config, work item metadata,
   or routing rules. For local dev, the simplest path is a workflow-level
   override in the `WORKFLOW.local-e2e.md` file.

### Soft blockers (can defer for MVP)

4. Platform token API — For local dev, a manually-inserted DB row or dev-mode
   bypass is sufficient. Full CRUD API is a polish item.

5. Capability probe — Assume the model works. Skip detection for now.

6. Platform UI — Not needed for local dev testing.

7. Install ergonomics (helper PR #10) — Manual binary start is fine.

8. Diagnostics (helper PR #11) — Nice to have, not blocking.

## Minimal Path to "Agent on Local Model"

### Phase 1: Dev-mode local relay (no platform DB changes)

**Runtime changes:**
- Add `LOCAL_RELAY_DEV_MODE` env flag to `TokenValidator` that accepts a
  hardcoded dev token (e.g., `lrh_dev_local_token`) without DB lookup.
- Add execution profile override in `WORKFLOW.local-e2e.md`:
  ```yaml
  execution_profile:
    runner_kind: local_relay
    target_runner_kind: openai_compatible
    provider: openai_compatible
    model: qwen3-coder:30b
  ```

**Helper changes:**
- Merge or cherry-pick the relay client wiring from PR #9.
- Configure `runtime.toml` to point at `ws://127.0.0.1:4000/local-relay/ws`
  with the dev token.

**Test flow:**
```bash
# Terminal 1: Start Ollama (already running on :11434)
ollama serve

# Terminal 2: Start runtime
pnpm run start:local

# Terminal 3: Start helper
cd local-runtime-helper
go run ./cmd/local-runtime-helper start --config ./dev-runtime.toml

# Terminal 4: Push a work item
curl -X POST http://127.0.0.1:4000/api/v1/items \
  -H 'content-type: application/json' \
  -d '{
    "id": "LOCAL-MODEL-1",
    "title": "Local model smoke test",
    "description": "Respond with a greeting."
  }'
```

**Success criteria:**
- Helper connects to runtime relay socket
- Runtime dispatches work item through Runner.LocalRelay
- Helper forwards to Ollama via OpenAI-compatible runner
- Runtime receives normalized `message.delta` + `run.completed` events
- Work item completes

### Phase 2: Platform integration (production path)

- PR1: DB migration for `local_runtime_machine` + `local_runtime_token`
- PR2: Token CRUD API
- PR9: ExecutionProfileResolver respects `local_relay` routing rules
- PR10: Settings UI for machine registration

### Phase 3: Hardening

- Capability probing and compatibility badges
- Offline/busy/timeout error surfacing in UI
- Observability (correlated logs, run snapshots)
- Install script for helper

## Files to Modify (Phase 1)

### parallel-agent-runtime

| File | Change |
|---|---|
| `lib/symphony_elixir/local_relay/token_validator.ex` | Add dev-mode bypass |
| `apps/orchestrator/WORKFLOW.local-e2e.md` | Add local_relay execution profile |
| `lib/symphony_elixir/execution_profile.ex` | Ensure local_relay profile fields pass through |
| `lib/symphony_elixir/agent_runner.ex` | Ensure execution profile reaches Runner.LocalRelay |

### local-runtime-helper

| File | Change |
|---|---|
| `internal/relay/relay.go` | Implement WSS client (from PR #9) |
| `cmd/local-runtime-helper/main.go` | Wire `start` subcommand to relay loop |
| `docs/runtime.toml.example` | Add dev config example |

### Config files (new)

| File | Purpose |
|---|---|
| `local-runtime-helper/dev-runtime.toml` | Dev config pointing at local runtime + Ollama |

## Open Questions

1. **Token bypass vs real migration first?** Dev-mode bypass is faster but
   adds a code path to maintain. Real migration is cleaner but requires
   Supabase changes.

2. **Which execution profile source for local dev?** Options:
   - Workflow YAML override (simplest, runtime-only)
   - Runner config in `.env` (existing pattern)
   - Work item label `runner:local_relay` (per-item control)

3. **Should Phase 1 use the existing Codex app-server at all?** The current
   `local_relay` runner bypasses Codex and calls Provider.OpenAICompatible
   directly. This means no workspace file operations, no tool use — just
   chat completions. Is that sufficient for the first test?

4. **Model selection**: `qwen3-coder:30b` is available locally (30.5B params,
   Q4_K_M quantization). OpenAI-compatible `/v1/chat/completions` endpoint
   confirmed working at `http://127.0.0.1:11434/v1`.
