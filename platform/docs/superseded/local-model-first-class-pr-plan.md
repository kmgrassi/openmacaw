# First-Class Local Model Support PR Plan

Scope document for making local models, especially Ollama/vLLM/LM Studio
OpenAI-compatible endpoints, a first-class execution backend for agents.

The target user experience:

1. User starts Ollama locally with a model such as `qwen2.5-coder`.
2. User installs/registers a local runtime helper.
3. Platform shows the local machine as online and detects available models.
4. User routes Planning, Coding, Manager, or custom agents to that local model
   when the model has the required capabilities.
5. Runtime dispatches work through the local helper without exposing local
   ports publicly.

## Current State

Pieces already exist or are scoped:

- `openai-compatible` is present in plan/schema enums.
- `routing_rule`, `routing_rule_match`, and `credential_alias` exist in
  platform migrations and generated types.
- `ExecutionProfile` separates agent role from runner/provider/model.
- OQ-02 documents the intended `local_relay` transport and calls out Ollama,
  vLLM, and LM Studio as OpenAI-compatible local endpoints.

Missing pieces:

- No `local_runtime_machine` / `local_runtime_token` tables yet.
- No local runtime helper daemon exists.
- No implemented `local_relay` runtime endpoint/runner exists.
- No OpenAI-compatible local runner implementation exists.
- No capability probe for local models exists.
- No platform UI for local machine registration, health, model detection, or
  compatibility warnings exists.

## Design Principles

- Local models are execution backends, not special-case agents.
- Do not treat OpenAI-compatible as fully OpenAI-equivalent.
- Route by detected capabilities, not by provider name alone.
- Keep local endpoints private; cloud reaches them through an outbound local
  helper connection.
- Credentials and runtime tokens are never logged or returned after creation.
- Running sessions keep resolved profile/capability snapshots; routing changes
  affect future runs unless explicit hot reload is built.

## Desired Runtime Shape

```text
agent / work item / user message
  -> ExecutionProfileResolver
  -> runner_kind: local_relay
  -> target_runner_kind: openai_compatible
  -> model: qwen2.5-coder:latest
  -> local runtime helper over WSS
  -> Ollama http://127.0.0.1:11434/v1/chat/completions
```

Example local helper config:

```toml
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key = "ollama"
model = "qwen2.5-coder:latest"
```

## Compatibility Model

Every local model should advertise or be probed for capabilities:

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

Routing should use these capabilities:

- plain chat: allow if completion works;
- planning: require JSON mode or structured-output repair/retry;
- coding with workspace-write tools: require tool-call capability or route to
  Codex/OpenClaw fallback;
- manager monitoring/summarization: allow if chat + context limits are enough;
- automated remediation: require the exact tool profile requested.

## PR Plan

| PR | Repository | Title | Database migration? | Scope | Acceptance |
|---|---|---|---|---|---|
| PR1 | `parallel-agent-platform` | Local runtime identity/token schema | Yes, but keep it minimal | Decide whether to extend `device_identity` or add `local_runtime_machine`; add only the missing token/registration fields needed for helper auth. Add RLS, indexes, generated Supabase types. | Machines/tokens can be created, listed, revoked, and queried by workspace. Token hashes only; plaintext token is never stored. |
| PR2 | `parallel-agent-platform` | Runtime token API and contracts | No additional if PR1 landed | Add contracts and API routes for creating/listing/revoking runtime tokens and machines. Return plaintext token exactly once. | `POST /api/runtime-tokens`, `GET /api/runtime-tokens`, `POST /api/runtime-tokens/:id/revoke` work with authz tests. |
| PR3 | `parallel-agent-runtime` | Local relay protocol and authenticated WS endpoint | No platform DB migration; reads PR1 tables | Add `local_relay` WS endpoint, register/auth frames, heartbeat, reconnect semantics, relay registry, and protocol docs/schema. | Local client can register runner kinds; invalid/revoked tokens fail; online machine registry updates. |
| PR4 | `parallel-agent-runtime` | Runtime `Runner.LocalRelay` adapter | No | Add runner adapter that selects an online local helper by workspace + target runner kind, dispatches frames with correlation IDs, handles progress/completion/error/cancel. | Runtime can dispatch to a mock local runner through the relay with typed errors for offline/busy/timeout. |
| PR5 | New repo `local-runtime-helper` | Daemon scaffold | No | Create helper daemon with config parser, WSS client, register frame, heartbeat/reconnect, mock runner, installable CLI skeleton. | Helper registers to runtime and completes a mock dispatch round trip in tests. |
| PR6 | `local-runtime-helper` | OpenAI-compatible local runner | No | Add runner for Ollama/vLLM/LM Studio via `/v1/chat/completions`, streaming, cancellation, timeouts, and model config. | Fake OpenAI-compatible server tests pass; manual Ollama Qwen completion works locally. |
| PR7 | `parallel-agent-runtime` | OpenAI-compatible event/tool normalization | No | Normalize local runner progress into runtime events: `message.delta`, `tool.started`, `tool.completed`, `run.completed`, `run.failed`, `usage.updated`. Add error taxonomy. | Platform sees the same event shapes for local model runs as other provider-backed runs. |
| PR8 | `parallel-agent-platform` | Capability probe API and persistence | Maybe | Add API route to request/record local runner capability probes. Persist latest model/capability snapshot if PR1 table exists; otherwise return live-only data. | UI/API can tell whether a local model supports streaming, JSON mode, tool calls, context window, and health. |
| PR9 | `parallel-agent-platform` | Execution profile/routing integration | Maybe small route-match migration only if needed | Let `ExecutionProfileResolver` resolve local model routes using `routing_rule` plus capability requirements. Add fallback route support for local offline/capability missing. | Planning Agent can resolve to local Qwen only when compatible; Coding Agent falls back when tool capability is missing. |
| PR10 | `parallel-agent-platform` | Local runtime setup UI | No | Add Settings UI for local machines, token generation, online/offline status, runner list, model/capability badges, and copyable helper config. | User can register a machine, see it online, see Qwen/Ollama capability state, and select it for compatible agents. |
| PR11 | `parallel-agent-runtime` + `parallel-agent-platform` | End-to-end Ollama/Qwen smoke harness | No | Add local/manual harness and API fixtures: start Ollama, start helper, route a test Planning Agent or chat run to Qwen, assert normalized completion/events. | One documented local smoke flow proves platform -> runtime -> helper -> Ollama -> runtime -> platform. |
| PR12 | `parallel-agent-platform` + `parallel-agent-runtime` | Hardening, guardrails, and observability | Maybe run snapshot columns if missing | Add max concurrency, queue/busy errors, health diagnostics, per-run resolved capability snapshots, correlated logs, and UI warnings. | Offline, busy, model-missing, context-overflow, timeout, and capability-missing states are typed and visible without leaking secrets. |

## Database Migration Review

Existing schema that should be reused where possible:

- `device_identity` already stores workspace/user-scoped devices with
  `device_id`, `fingerprint`, `public_key`, `last_seen_at`, and revocation
  fields. This may be the right base table for local runtime helper identity.
- `engine_instance` tracks an agent-specific launched runtime process by host,
  port, status, and health. It should not be stretched into a local-helper
  registry because a helper can be workspace-scoped and serve many agents and
  runner kinds.
- `gateway_config_state` tracks config sync/apply state. It should not become
  machine registration or model capability state.
- `broker_run.metadata` and `session_thread.metadata` can hold resolved-profile
  and capability snapshots initially. Do not add run/session snapshot columns
  until query requirements prove JSON metadata is insufficient.
- `routing_rule`, `routing_rule_match`, `credential`, and `credential_alias`
  already cover routing and credential references. Do not add an
  `execution_profile` table for local models.

Conclusion:

- We likely need **some** migration for local helper authentication/registration.
- We do **not** need all proposed tables on day one.
- Prefer either:
  - extend `device_identity` for helper registration and add a small
    `local_runtime_token` table; or
  - add purpose-built `local_runtime_machine` + `local_runtime_token` only if
    browser/device auth and runtime-helper auth should remain separate.
- Treat `local_runtime_capability_snapshot` as optional until UI/API query needs
  require persisted capability history.

## Candidate Database Migrations

### Option A: Reuse `device_identity`

This is the conservative first choice if local helper identity can share the
same device lifecycle as existing gateway device auth.

Potential migration:

```sql
alter table public.device_identity
  add column if not exists device_kind text not null default 'browser',
  add column if not exists runner_kinds text[] not null default '{}',
  add column if not exists metadata jsonb not null default '{}',
  add column if not exists last_capability_probe_at timestamptz;

create index if not exists device_identity_workspace_kind_active_idx
  on public.device_identity (workspace_id, device_kind, revoked, last_seen_at desc);

create unique index if not exists device_identity_device_workspace_key
  on public.device_identity (device_id, workspace_id);
```

Then add a narrow token table:

```sql
create table public.local_runtime_token (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  token_hash text not null,
  name text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint local_runtime_token_device_fkey
    foreign key (device_id, workspace_id)
    references public.device_identity (device_id, workspace_id)
    on delete cascade
);

create unique index local_runtime_token_active_hash_idx
  on public.local_runtime_token (token_hash)
  where revoked_at is null;
```

### Option B: Purpose-Built Local Runtime Registry

Use this if we want runtime-helper machines completely separate from browser
device identities.

```sql
create table public.local_runtime_machine (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references public."user"(id) on delete cascade,
  display_name text not null,
  runner_kinds text[] not null default '{}',
  metadata jsonb not null default '{}',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index local_runtime_machine_workspace_active_idx
  on public.local_runtime_machine (workspace_id, revoked_at, last_seen_at desc);

create table public.local_runtime_token (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  token_hash text not null,
  name text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index local_runtime_token_active_hash_idx
  on public.local_runtime_token (token_hash)
  where revoked_at is null;
```

### Optional: Capability Snapshots

Add this only if capability history/querying becomes useful. For MVP, latest
capabilities can live in `device_identity.metadata`,
`local_runtime_machine.metadata`, or be returned live from the helper.

```sql
create table public.local_runtime_capability_snapshot (
  id uuid primary key default gen_random_uuid(),
  machine_id uuid not null references public.local_runtime_machine(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  runner_kind text not null,
  provider text not null,
  model text not null,
  endpoint_fingerprint text,
  capabilities jsonb not null default '{}',
  health_status text not null default 'unknown',
  last_probe_error text,
  probed_at timestamptz not null default now()
);

create index local_runtime_capability_machine_idx
  on public.local_runtime_capability_snapshot (machine_id, runner_kind, model, probed_at desc);

create index local_runtime_capability_workspace_idx
  on public.local_runtime_capability_snapshot (workspace_id, runner_kind, provider, model);
```

### Optional: Run/Profile Snapshot Fields

Only add this if existing run/session tables cannot store resolved profile
metadata safely:

- `resolved_runner_kind`
- `resolved_provider`
- `resolved_model`
- `resolved_machine_id`
- `resolved_capabilities jsonb`
- `execution_profile_source jsonb`

These should be diagnostic snapshots, not the editable source of truth.

### Existing Tables To Reuse

Do not add a new execution-profile table for this feature. Reuse:

- `routing_rule`
- `routing_rule_match`
- `credential`
- `credential_alias`
- `agent`
- `gateway_config` only for compatibility/opaque runtime policy

## Error Taxonomy

Use typed errors across runtime/API/UI:

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

## Security Requirements

- Runtime token is workspace-scoped and machine-scoped.
- Store only token hashes.
- Plaintext token is returned only on creation.
- Revocation is immediate for new dispatches and closes active helper sockets
  where practical.
- Local endpoints are never exposed publicly.
- Local endpoint URLs and API keys are not written to prompts or provider event
  logs.
- Logs may include endpoint fingerprints, not full secrets.

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
- `capability_snapshot_id` if persisted
- typed failure reason

## Product Acceptance

The first-class feature is ready when:

- a user can register a local machine from the UI;
- the platform can detect an Ollama Qwen model;
- compatibility badges explain which agents can use the model;
- Planning Agent can use local Qwen for a compatible planning/chat path;
- Coding Agent routes to local Qwen only when tool requirements are met or
  falls back cleanly;
- local runtime offline/busy/model-missing states are understandable;
- no inbound network access to the user's machine is required.
