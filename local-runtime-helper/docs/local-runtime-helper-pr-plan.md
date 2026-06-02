# Local Runtime Helper PR Plan

This document scopes only the work that belongs in `local-runtime-helper`.
Platform APIs, runtime relay endpoints, and Harper Server migrations are external
dependencies. They are named here only where the helper needs a contract to
integrate against them.

## Repository Responsibility

`local-runtime-helper` is the user-machine daemon. Its job is to:

- read local config from the user's machine;
- store only local daemon configuration, never Supabase state;
- connect outbound to the cloud relay over WSS;
- authenticate with a platform-issued local runtime token;
- advertise local runner capabilities;
- accept dispatches from the cloud relay;
- execute local tools or local model calls;
- stream progress, output, completion, and typed errors back to the cloud;
- provide local install, status, diagnostics, and troubleshooting commands.

It should not own:

- database migrations;
- token issuance or revocation APIs;
- dashboard UI;
- cloud relay server endpoints;
- agent routing or execution-profile resolution;
- Supabase clients or direct Supabase calls.

## Current State

The repository is a scaffold:

- `cmd/local-runtime-helper/main.go` has `register`, `start`, and `version`
  commands, but `register` and `start` are not implemented.
- `internal/config` contains placeholder config types.
- `internal/protocol` contains only `SchemaVersion`.
- `internal/relay` is a placeholder for the persistent WSS client.
- `internal/runner` defines the generic runner interface.
- `docs/runtime.toml.example` shows planned `openai_compatible` and `openclaw`
  runner configuration.

## Helper-Only PR Scope

| PR | Owner Files | Helper Deliverables | External Contract Needed | Acceptance |
| --- | --- | --- | --- | --- |
| PR 1: Config Parser | `internal/config/**`, `docs/runtime.toml.example` | Implement `runtime.toml` parsing, config path resolution, safe validation, env overrides for endpoint/token, and typed runner config structs for `openai_compatible` and `openclaw`. | Runner-kind strings must match the platform/runtime contract. | `go test ./...`; invalid configs return actionable errors; the example config parses successfully. |
| PR 2: Wire Protocol Types | `internal/protocol/**` | Add typed JSON frames for register, register_ack, dispatch, progress, output, complete, error, heartbeat, and cancel. Include schema-version validation and encode/decode helpers. | Runtime owns the canonical relay protocol; helper mirrors it. | Round-trip tests for every frame; unknown frame type and version mismatch produce typed errors. |
| PR 3: Register Command | `cmd/local-runtime-helper/**`, `internal/config/**` | Implement `register` to write local config from CLI flags: cloud endpoint, workspace id, display name, and one-time token. Use safe file permissions and explicit overwrite behavior. | Platform must mint the one-time token and provide the relay endpoint. | Manual command writes valid config; token is not printed after write; existing config requires `--force`. |
| PR 4: Relay Client | `internal/relay/**` | Implement the outbound WSS client: bearer-token auth, register frame, register ack handling, heartbeat, reconnect with jittered backoff, graceful shutdown, and cancellation plumbing. | Runtime must expose the WSS relay endpoint and frame semantics. | Unit tests cover reconnect/backoff and heartbeat timeout; manual run reaches a compatible relay endpoint. |
| PR 5: OpenAI-Compatible Runner | `internal/runner/openai_compatible/**`, `internal/runner/**`, `docs/runtime.toml.example` | Add a runner for local OpenAI-compatible HTTP endpoints. Support Ollama-style `/v1/chat/completions`, streaming where available, non-streaming fallback, cancellation, and typed error normalization. | Runtime dispatch payload must define the OpenAI-compatible request envelope. | Works against Ollama with a Qwen model; tests cover request construction, streaming parse, fallback, errors, and cancellation. |
| PR 6: OpenClaw Runner | `internal/runner/openclaw/**`, `internal/runner/**` | Add a separate OpenClaw runner adapter for local OpenClaw execution. Keep this distinct from model execution. | Runtime dispatch payload must define the OpenClaw request envelope. | Dispatches route by `openclaw`; tests use a fake local OpenClaw server. |
| PR 7: Dispatch Router | `internal/relay/**`, `internal/runner/**` | Wire inbound dispatch frames to configured runners. Add correlation IDs, bounded concurrency, per-dispatch cancellation, progress/output streaming, and typed error frames for unknown runner kinds. | Runtime must send dispatches with runner kind and correlation id. | Multiple dispatches can run concurrently; cancellation stops the local request; unknown runner kind returns an error frame. |
| PR 8: Local Diagnostics | `internal/diagnostics/**`, `internal/relay/**`, `internal/runner/**`, `cmd/local-runtime-helper/**` | Add structured local logs and `doctor` checks for config validity, cloud reachability, token presence, runner endpoint reachability, model availability, and relay connection state. | Platform/runtime may later consume these logs, but helper should work locally without that. | Logs include correlation id, runner kind, model, endpoint host, and typed failure reason; secrets are redacted. |
| PR 9: Install And Lifecycle | `cmd/local-runtime-helper/**`, `docs/install.md`, `.github/**` | Add release build workflow, install docs, macOS launchd template, `start`, `status`, and local logout/reset guidance. | Platform should provide user-facing install/token instructions, but helper owns local lifecycle behavior. | Fresh machine setup works from docs; `status` reports config, relay, and runner readiness. |

## Local Model Compatibility

The OpenAI-compatible runner should make local models usable without special
cloud assumptions. The endpoint is the source of truth for HTTP shape, and the
configured model name is passed through unchanged.

Example Ollama config:

```toml
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
model = "qwen2.5-coder:latest"
api_key = "ollama"
```

The runner should tolerate common local-server behavior:

- streaming and non-streaming responses;
- empty or placeholder API keys;
- slower first-token latency while the model loads;
- model-not-found errors that include the configured model name;
- local endpoint connection refused errors with a `doctor` hint.

## External Dependencies

These are not helper-owned PRs, but the helper depends on them:

- Platform: issue/register/revoke local runtime tokens.
- Platform: expose relay endpoint and install/register instructions to users.
- Runtime: host the WSS relay endpoint and validate helper tokens.
- Runtime: define dispatch payloads and event envelopes.
- Harper Server: store local runtime machines and token hashes.

The helper should consume these contracts through HTTP/WSS and local config only.
It should not import platform/runtime code and should never connect directly to
Supabase.

## Parallel Work Notes

Parallel agents should keep write ownership narrow:

- Config and protocol can proceed independently.
- Runner adapters can be built with fake dispatch payloads, then wired into the
  relay once protocol types land.
- OpenAI-compatible and OpenClaw runners should remain separate packages.
- Diagnostics can start with local log/event field definitions, then integrate
  after relay and runners land.
- Install/lifecycle work should depend on public command/config APIs rather than
  internal runner details.
