# Runtime First-Class Local Model Support PR Plan

Runtime companion to the platform plan for making local models, especially
Ollama/vLLM/LM Studio OpenAI-compatible endpoints, first-class agent execution
backends.

The platform companion owns UI, local-runtime token APIs, routing rules, and
database migrations. Runtime owns the local relay protocol, relay-backed runner,
provider/event normalization, dispatch hardening, and local smoke harnesses.

Companion platform PR: `parallel-agent-platform` local model first-class plan.

## Target Runtime Shape

```text
agent / work item / user message
  -> platform ExecutionProfileResolver
  -> runtime receives resolved profile
  -> runner_kind: local_relay
  -> target_runner_kind: openai_compatible
  -> model: qwen2.5-coder:latest
  -> local runtime helper over WSS
  -> Ollama http://127.0.0.1:11434/v1/chat/completions
```

Example helper config:

```toml
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key = "ollama"
model = "qwen2.5-coder:latest"
```

## Current Runtime State

Already present or partially present:

- `ExecutionProfile` includes local/model-agnostic provider concepts.
- `Provider.OpenAICompatible` exists as a provider module.
- Docs already describe `local_relay` as a generic transport for local runners.
- Backend adapter docs describe capability-based target selection.

Missing or incomplete:

- No authenticated local helper WebSocket endpoint.
- No relay registry that maps `(workspace_id, runner_kind)` to online local
  helper connections.
- No `Runner.LocalRelay` adapter.
- No local helper daemon repo/binary.
- No OpenAI-compatible local runner inside that helper.
- No capability probe/registration frame for local model support.
- No end-to-end Ollama/Qwen smoke harness.

## Compatibility Model

Runtime should never assume OpenAI-compatible means fully OpenAI-equivalent.
Each helper registration or probe should produce capability metadata:

```json
{
  "runner_kind": "openai_compatible",
  "provider": "ollama",
  "model": "qwen2.5-coder:latest",
  "capabilities": {
    "streaming": true,
    "tool_calls": false,
    "structured_output": "best_effort",
    "json_mode": true,
    "context_window": 32768
  }
}
```

Runtime routing/dispatch decisions should use capability requirements:

- chat/summarization requires basic completion;
- planning requires JSON mode or repair/retry support;
- coding with workspace-write tools requires tool-call capability or a fallback
  to Codex/OpenClaw;
- manager remediation requires the requested tool profile capability.

## Runtime PR Plan

| PR | Repository | Title | Platform dependency | Scope | Acceptance |
|---|---|---|---|---|---|
| PR1 | `parallel-agent-runtime` | Local relay protocol spec and WS endpoint | Platform local runtime identity/token API | Add authenticated `local_relay` WebSocket endpoint, register/auth frames, heartbeat, reconnect semantics, relay protocol docs/schema, and token validation hooks. | Local client can connect/register runner kinds; revoked/invalid tokens fail; heartbeat updates online state. |
| PR2 | `parallel-agent-runtime` | Relay registry and `Runner.LocalRelay` adapter | PR1 | Add in-process registry for online helpers keyed by workspace and target runner kind. Add `Runner.LocalRelay` that dispatches with correlation IDs, streams progress, handles completion/error/cancel. | Mock local helper round trip works; offline, busy, timeout, protocol-error states are typed. |
| PR3 | New repo `local-runtime-helper` | Local helper daemon scaffold | PR1 protocol docs/schema | Create helper daemon with config parser, WSS client, register frame, heartbeat/reconnect, CLI skeleton, and mock runner. | Helper registers to runtime and completes mock dispatch round trip in tests. |
| PR4 | `local-runtime-helper` | OpenAI-compatible local runner | PR3 | Add runner for Ollama/vLLM/LM Studio using `/v1/chat/completions`, streaming, cancellation, model config, request timeout, and local endpoint health check. | Fake OpenAI-compatible server tests pass; manual Ollama Qwen completion works. |
| PR5 | `parallel-agent-runtime` | Local capability registration and probe handling | PR1, PR3/PR4 | Extend register/probe frames to include runner/model capabilities. Normalize capability payloads and expose them to platform state/reporting hooks. | Runtime knows which models each helper can run and whether streaming/json/tool-calls are supported. |
| PR6 | `parallel-agent-runtime` | OpenAI-compatible event normalization hardening | Existing `Provider.OpenAICompatible` | Ensure local OpenAI-compatible chunks map to normalized runtime events: `message.delta`, `tool.started`, `tool.completed`, `run.completed`, `run.failed`, `usage.updated`. | Local model output appears identical to other provider-backed runs at the platform event boundary. |
| PR7 | `parallel-agent-runtime` | Dispatch hardening for local models | PR2 | Add concurrency limits, cancel propagation, backpressure, queue/busy handling, timeout budgets, and retry/fallback-compatible error categories. | Runtime returns typed errors for offline, busy, model missing, endpoint unreachable, context overflow, generation timeout. |
| PR8 | `parallel-agent-runtime` + `parallel-agent-platform` | End-to-end Ollama/Qwen smoke harness | Platform routing/execution-profile integration | Add local/manual harness: start Ollama, optionally start helper/runtime stack, route a test Planning Agent/chat run to Qwen when relay support is present, and assert normalized events and completion. Runtime repo fallback: `pnpm run smoke:local-ollama-qwen` proves Ollama -> OpenAI-compatible provider -> normalized events. | One documented local smoke flow proves platform -> runtime -> helper -> Ollama -> runtime -> platform once PR1-PR7/platform routing are present; until then, the runtime harness proves the local model normalization leg without requiring missing relay code. |
| PR9 | `parallel-agent-runtime` | Observability and diagnostics for local runs | PR2/PR5 | Add structured logs and runtime health diagnostics with workspace, agent, run/session, machine, runner, provider, model, capability snapshot, and typed failure reason. | Runtime logs/debug endpoints make local model failures diagnosable without exposing secrets or full local endpoint credentials. |

## Runtime Error Taxonomy

Use typed errors throughout relay and runner code:

- `local_runtime_offline`
- `local_runtime_token_revoked`
- `local_runner_busy`
- `local_runner_timeout`
- `endpoint_unreachable`
- `model_not_found`
- `capability_missing`
- `context_overflow`
- `generation_timeout`
- `local_runner_protocol_error`

These errors should be safe to surface to platform/UI and should not include
API keys, bearer tokens, or full local endpoint credentials.

## Relay Protocol Requirements

Minimum frame types:

- `register`: helper advertises workspace, machine, runner kinds, models, and
  capabilities.
- `heartbeat`: helper keeps the machine online and can include refreshed
  capability snapshots.
- `dispatch`: runtime sends work to a target runner kind/model.
- `progress`: helper streams normalized or provider-adjacent progress.
- `complete`: helper marks dispatch complete with final output/usage.
- `error`: helper returns typed, safe failure.
- `cancel`: runtime asks helper to cancel an in-flight dispatch.

Every dispatch frame should include:

- `correlation_id`
- `workspace_id`
- `agent_id`
- `run_id` or `session_id`
- `runner_kind` / `target_runner_kind`
- `provider`
- `model`
- capability requirements
- redacted credential reference metadata only, never secret material

## Security Requirements

- Helper authentication uses a workspace-scoped machine token created by the
  platform API.
- Runtime stores/compares token hashes only through platform/Supabase lookups.
- Revoked tokens fail new connections and should close active sockets when
  detected.
- Local endpoints stay private; no inbound port is required.
- Runtime logs may include endpoint fingerprints, not full secret-bearing
  endpoint config.
- Helper must redact local API keys and bearer tokens from progress/error
  frames.

## Observability Requirements

Every local-model run should log/carry:

- `workspace_id`
- `agent_id`
- `run_id` / `session_id`
- `machine_id`
- `runner_kind`
- `target_runner_kind`
- `provider`
- `model`
- `capability_snapshot_id` if platform persists one
- typed failure reason

Runtime debug/health endpoints should distinguish:

- helper disconnected;
- helper online but target runner not registered;
- endpoint unreachable from helper;
- model unavailable;
- capability mismatch;
- generation timeout;
- local runner busy.

## Database Notes

Runtime should not own the schema migrations. It depends on platform-owned
persistence for local helper identity, token validation, and optional capability
state.

After reviewing the current platform schema, do not assume every proposed table
is required:

- `device_identity` already stores workspace/user-scoped device records with
  `device_id`, `fingerprint`, `public_key`, `last_seen_at`, and revocation
  fields. This may be enough for local helper machine identity if we extend it
  with runner metadata, or pair it with a small token table.
- `engine_instance` tracks launcher/runtime processes by `agent_id`, host, port,
  status, and health. It is not a good fit for local helper machines because
  helpers are workspace-scoped and can serve many agents/runners.
- `gateway_config_state` tracks config sync state, not online helper
  registration.
- `broker_run.metadata` and `session_thread.metadata` can hold resolved-profile
  and capability snapshots initially, so avoid adding run/session snapshot
  columns until query requirements prove they are needed.
- `routing_rule`, `routing_rule_match`, `credential`, and `credential_alias`
  already cover routing and credential references. Do not add an
  `execution_profile` table for local models.

Minimum likely platform migration:

- either extend `device_identity` for helper registration (`runner_kinds`,
  `metadata`, maybe `last_capability_probe_at`) and add a
  `local_runtime_token` table keyed to `device_identity.device_id`; or
- add a purpose-built `local_runtime_machine` table plus `local_runtime_token`
  if we want to keep browser/device auth and runtime-helper auth separate.

Optional later migration:

- a `local_runtime_capability_snapshot` table only if the UI/API needs to query
  capability history or compare multiple probes. Until then, latest capability
  data can live in helper registration metadata or be returned live.

Runtime should access these platform-owned records through existing
Supabase/service-role patterns or platform APIs, depending on the deployment
path chosen for token validation and capability reporting.

## Non-Goals

- Do not expose local Ollama/vLLM endpoints directly to cloud services.
- Do not make OpenAI-compatible synonymous with OpenAI/Codex.
- Do not require local models to support all agent roles.
- Do not store raw provider streams unless a later logging decision requires it.
- Do not add new global singleton runner state; relay registrations are
  workspace/machine/runner scoped.

## Runtime Acceptance

The runtime side is ready when:

- a local helper can connect outbound and register an OpenAI-compatible runner;
- runtime can dispatch to a local Qwen/Ollama model through the helper;
- local output is normalized into existing runtime event shapes;
- offline/busy/missing-model/capability errors are typed;
- helper/local model state is observable without leaking secrets;
- platform can route a compatible agent to the local model and fall back when
  requirements are not met.
