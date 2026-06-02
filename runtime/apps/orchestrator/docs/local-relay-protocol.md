# Local Relay WebSocket Protocol

Runtime exposes an outbound-helper WebSocket endpoint at:

```text
GET /local-relay/ws
```

Frame shapes are captured in
[`local-relay-protocol.schema.json`](local-relay-protocol.schema.json).

Local runtime helpers connect from the user's machine to this endpoint, register
workspace-scoped runner capabilities, and keep their online state fresh with
heartbeats. Runtime never connects directly to local Ollama, vLLM, LM Studio, or
other private model endpoints.

## Authentication

Helpers authenticate with a workspace-scoped machine token created by the
platform. Runtime validates tokens through
`SymphonyElixir.LocalRelay.TokenValidator`; production deployments should back
that adapter with platform or Supabase token lookups.

The socket accepts the token in either place:

- `Authorization: Bearer <token>`
- `register.auth.token`

The default config-backed validator reads SHA-256 token hashes from
`:local_relay_token_hashes`. It is intended for tests and local deployments,
not as the long-term platform token store.

Invalid or revoked tokens fail the registration and close the socket with a safe
typed error. Runtime must not log raw tokens.

## Register

The helper's first application frame must be `register`.

```json
{
  "type": "register",
  "workspace_id": "workspace-id",
  "machine_id": "machine-id",
  "auth": {
    "token": "workspace-machine-token"
  },
  "runner_kinds": ["openai_compatible"],
  "runners": [
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
  ],
  "metadata": {
    "helper_version": "0.1.0"
  }
}
```

Successful registration returns:

```json
{
  "type": "registered",
  "protocol": 1,
  "workspace_id": "workspace-id",
  "machine_id": "machine-id",
  "heartbeat_interval_ms": 30000,
  "reconnect": {
    "backoff_ms": [1000, 2000, 5000, 15000],
    "jitter": true
  }
}
```

## Heartbeat

Helpers should send `heartbeat` at least once per advertised interval. A
heartbeat can include refreshed runner metadata or capability snapshots.

```json
{
  "type": "heartbeat",
  "correlation_id": "hb-001",
  "ts": 1777200000000,
  "runner_kinds": ["openai_compatible"],
  "metadata": {
    "helper_version": "0.1.1"
  }
}
```

Runtime responds:

```json
{
  "type": "heartbeat_ack",
  "correlation_id": "hb-001",
  "ts": 1777200000000,
  "server_ts": 1777200000100
}
```

Heartbeat updates the helper's `last_seen_ms` in runtime presence state. Socket
termination removes the helper from online presence.

## Dispatch Tool Grants

Runtime dispatch frames carry the model-facing tool policy for the current turn.
When Platform supplies effective grants, runtime passes those grant-derived
definitions through `tool_definitions` and derives `provider_tool_specs` from
the same list. Role defaults and template selections are not sent as runtime
policy. Runner configs may provide the effective definitions as
`tool_definitions` or the existing camelCase `toolDefinitions` key; outbound
relay frames use `tool_definitions`.

Planner local-relay dispatches use:

```json
{
  "type": "dispatch",
  "runner_kind": "planner",
  "tool_calling_mode": "cloud_managed",
  "tool_definitions": [
    {
      "name": "plan.create",
      "description": "Create a plan",
      "inputSchema": {"type": "object"}
    }
  ],
  "provider_tool_specs": [
    {
      "type": "function",
      "function": {
        "name": "plan_create",
        "description": "Create a plan",
        "parameters": {"type": "object"}
      }
    }
  ]
}
```

Manager local-relay dispatches follow the same rule. `tool_definitions` is the
effective set; `provider_tool_specs` is only the provider-specific projection of
that set. A tool omitted from `tool_definitions` must be absent from
`provider_tool_specs` and remains denied by runtime tool execution.

## Safe Error Codes

The relay socket only returns safe, typed error codes:

- `missing_token`
- `invalid_token`
- `local_runtime_token_revoked`
- `workspace_mismatch`
- `machine_mismatch`
- `validator_unavailable`
- `local_runtime_offline`
- `local_runner_protocol_error`

Later dispatch PRs will extend this with runtime execution errors such as
`local_runner_busy`, `endpoint_unreachable`, `model_not_found`, and
`generation_timeout`.
