# local-runtime-helper

A small Go daemon that bridges a user's machine to the Harper
cloud orchestrator. Lets the orchestrator dispatch work to local
tools (OpenClaw, OpenAI-compatible model endpoints, video
editors, browser automation, etc.) without exposing the user's
machine to inbound traffic.

The cloud connects **out** to nothing; the daemon connects **out**
to the cloud over WSS. NAT-friendly, multiplexed, single
persistent connection.

> **Status:** scaffold only. The connect/auth/register/heartbeat
> loop ships in OQ-02 PR 6; the first runner adapter
> (OpenAI-compatible) ships in OQ-02 PR 7. See the canonical
> implementation plan at
> [`parallel-agent-platform/docs/oq-02-local-runtime-connector-pr-plan.md`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/oq-02-local-runtime-connector-pr-plan.md).

## Layout

```
cmd/local-runtime-helper/   entrypoint — register / start / version subcommands
internal/config/            ~/.config/harper/runtime.toml parser (PR 6)
internal/relay/             persistent WSS client + reconnect loop (PR 6)
internal/protocol/          wire-protocol frame types (PR 6, mirrors cloud)
internal/runner/            runner adapter interface
internal/runner/<each>/     per-tool implementations (PR 7+)
docs/runtime.toml.example   example config
docs/install.md             install instructions (placeholder; PR 8)
.github/workflows/          CI
```

## Building

```sh
go build ./...
go test ./...
go vet ./...
```

## Installing

Install the latest tagged release with:

```sh
curl -fsSL https://raw.githubusercontent.com/kmgrassi/local-runtime-helper/main/install.sh | sh
```

The installer detects macOS/Linux and arm64/amd64, verifies the release archive
against `checksums.txt`, and writes the binary to
`~/.local/bin/local-runtime-helper`. To pin a release:

```sh
curl -fsSL https://raw.githubusercontent.com/kmgrassi/local-runtime-helper/v0.1.0/install.sh | sh -s -- --version v0.1.0
```

See `docs/install.md` for configuration and launchd setup.

## Configuring runners

Each `[runner.<kind>]` table in `runtime.toml` registers one local tool this
helper will advertise to the cloud relay. The helper only advertises runners
it can actually serve, so adding a stanza both enables the runner *and*
tells the cloud the matching `runner_kind` is available.

Today the helper ships two adapters:

```toml
# OpenAI-compatible chat-completion endpoint (Ollama, llama.cpp, vLLM, ...).
[runner.openai_compatible]
endpoint = "http://127.0.0.1:11434/v1"
api_key  = "ollama"
model    = "qwen2.5-coder:latest"

# Local OpenClaw HTTP server. Advertises runner_kind = "openclaw".
[runner.openclaw]
endpoint = "http://127.0.0.1:7100"
# api_key = "optional-bearer-token"
```

Either block, both, or any future runner kind can be present — the helper
fails fast if zero runners are configured. See
`docs/runtime.toml.example` for the full annotated example.

## Wire protocol

The cloud-side spec lives in
[`parallel-agent-runtime/apps/orchestrator/docs/local-relay-protocol.md`](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/apps/orchestrator/docs/local-relay-protocol.md)
(added in OQ-02 PR 2). The Go types in `internal/protocol/`
mirror that spec; a parity test (PR 6) will fail CI on drift.
