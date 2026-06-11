# Local Runtime Helper — Agent Guide

## Project Structure

Go daemon that runs on the user's machine and connects to the runtime
via WSS relay:

```
cmd/local-runtime-helper/    — CLI entry point (register, start, etc.)
internal/config/             — TOML config parser
internal/protocol/           — Wire frame types (9 frame types)
internal/relay/              — WSS client + dispatcher
internal/runner/             — Runner adapters (openai_compatible, openclaw)
internal/diagnostics/        — Structured diagnostic events
docs/                        — Scoping documents and PR plans
```

## Before You Start

1. Go 1.23+ installed
2. Ollama installed and running (`ollama serve`)
3. A model pulled (`ollama pull qwen3-coder:30b`)

## Validation — REQUIRED Before Every Commit

```bash
go build ./...
go vet ./...
go test ./...
```

All three must pass. Do not push code that fails.

## Testing — Full Stack

The helper connects to the runtime's relay socket. Testing the full
flow requires all services:

```bash
# Terminal 1: Ollama
ollama serve

# Terminal 2: Runtime (in runtime/)
cd ../runtime && pnpm run start:local

# Terminal 3: Platform (in platform/)
cd ../platform && pnpm run dev

# Terminal 4: Helper
go run ./cmd/local-runtime-helper start --config ./dev-runtime.toml --log-level debug
```

**Verify the helper registered:**
```bash
# Check Ollama is reachable
curl http://localhost:11434/api/tags

# Check runtime health
curl http://127.0.0.1:4000/api/v1/health

# Check helper relay connection (look for "registered with relay" in helper logs)

# Run the diagnostic from platform
curl "http://127.0.0.1:3100/api/diagnostic/agents/<agent-id>?workspaceId=<workspace-id>"
```

## No Backwards Compatibility Shims

When a value, format, or API shape needs to change:

1. **Change it everywhere** across all repos in the same PR or set of PRs
2. **Do NOT add "also accept the old form" logic** — no dual-format support,
   no legacy aliases, no normalization hacks
3. **The only exception** is a truly external API where you can't coordinate
   the change

When you encounter inconsistency, fix it at the source. Refactor through
the entire codebase rather than adding a compatibility layer.

## Dev Config

`dev-runtime.toml` for local testing:

```toml
[machine]
display_name = "dev-machine"

[cloud]
endpoint = "ws://127.0.0.1:4000"
workspace_id = "dev-workspace"
token = "lrh_dev_local_token_2026"

[runner.openai_compatible]
endpoint = "http://localhost:11434/v1"
model = "qwen3-coder:30b"
```

## Local Services

| Service | Port | Repo |
|---------|------|------|
| Ollama | 11434 | System |
| Runtime orchestrator | 4000 | runtime/ |
| Runtime launcher | 4100 | runtime/ |
| Platform API | 3100 | platform/ |
| Platform web UI | 5173 | platform/ |

## Enum/String Conventions

All enum-like values use **snake_case**: `openai_compatible`, `local_runtime`.
Never use hyphens. Must match the database check constraints; the canonical
runner-kind list lives in `platform/contracts/runner-kinds.ts`.

## Key Architecture Rules

- **The helper runs on the user's machine.** It has access to local
  filesystems, git repos, shell, and the local model endpoint.
- **Tool execution is local.** When a model calls a tool, the helper
  executes it — not the cloud runtime.
- **One connection per token.** The relay socket enforces one active
  connection per machine token.
- **Advertise only initialized runners.** Only register runner kinds
  that were actually built in `cmdStart`, not all config sections.

## Related Subsystems

- `../platform` — TypeScript API + React frontend
- `../runtime` — Elixir orchestrator/launcher
- Historical `harper-server` schemas are provenance only. Current OpenMacaw
  database changes belong in `platform/supabase/migrations/`.
