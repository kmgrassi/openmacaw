# Local Model Coding Smoke Harness

This PR4 harness manually proves the local coding path before the production
`LocalModelCoding` runner is exposed through platform routing:

```text
local OpenAI-compatible model
  -> Runtime tool definitions
  -> Runtime-owned shell.exec read
  -> Runtime-owned apply_patch executor
  -> Runtime-owned shell.exec verification
  -> disposable workspace mutation
  -> final model response
```

The harness is intentionally narrow. It does not use `codex app-server`, and it
does not depend on the local relay helper. It directly exercises
`Provider.OpenAICompatible` plus Runtime-owned coding tool execution.

## Prerequisites

Start an OpenAI-compatible local model endpoint, for example Ollama:

```bash
ollama serve
ollama pull qwen2.5-coder:latest
```

Ollama exposes the OpenAI-compatible API at `http://127.0.0.1:11434/v1`.

## Run

From `apps/orchestrator`:

```bash
mix local_model.coding_smoke
```

Useful overrides:

```bash
mix local_model.coding_smoke \
  --base-url http://127.0.0.1:11434/v1 \
  --model qwen2.5-coder:latest \
  --workspace /tmp/local-model-coding-smoke
```

The task also reads:

- `SYMPHONY_LOCAL_MODEL_BASE_URL`
- `OLLAMA_OPENAI_BASE_URL`
- `OLLAMA_BASE_URL`
- `SYMPHONY_LOCAL_MODEL_NAME`
- `OLLAMA_MODEL`
- `SYMPHONY_LOCAL_MODEL_API_KEY`
- `OLLAMA_API_KEY`
- `SYMPHONY_LOCAL_MODEL_CODING_SMOKE_WORKSPACE`

## What It Proves

The smoke flow creates a disposable workspace with:

- `message.txt` containing `before`
- `test.sh`, which passes only when `message.txt` contains `after`

Then Runtime asks the model to:

1. Call `shell.exec` with `{"argv":["cat","message.txt"]}` to read the fixture.
2. Call `apply_patch` with a unified patch that changes `message.txt`.
3. Call `shell.exec` with `{"argv":["./test.sh"]}` to verify the edit.
4. Return a final answer after the command result.

A successful run prints the workspace path, observed tool calls, normalized event
names, and the model's final response. The workspace is left on disk so the diff
and files can be inspected.

Expected event evidence includes:

- `provider_dispatch_started` and `provider_dispatch_completed`
- `tool_call_started`
- `command_output_delta` and `command_completed`
- `patch_apply_begin` and `patch_apply_end`
- `tool_call_completed`
- `final_response`

Failure output is phase-tagged so it is clear whether the blocker is model
selection, provider dispatch, provider parsing, tool schema translation,
execution policy, or event persistence. This harness does not require a local
relay helper, so helper availability is out of scope for this specific flow.

## Browser Manual Smoke Coordination

After Platform exposes the local-model Coding Agent, use this runtime smoke as
the event-shape baseline for the browser flow:

1. Start Runtime with `pnpm run start:local`.
2. Start Platform from `parallel-agent-platform` with `pnpm run dev`.
3. Open `http://127.0.0.1:5173`, sign in, and choose the local-model Coding
   Agent.
4. Send one read prompt that asks the agent to inspect a small workspace file.
   The visible tool evidence should include a `shell.exec` tool call plus command
   output.
5. Send one edit prompt that asks the agent to make a trivial file change. The
   visible tool evidence should include `apply_patch`, patch apply events, tool
   completion, and a final assistant response.

Browser-visible event names and result shapes should match the runtime smoke
names above.

## Current Boundary

This is a manual smoke harness, not the production coding runner. The production
runner still needs platform-routed local coding session wiring, but this harness
verifies the critical PR4 behavior: local model tool choice, Runtime-owned
read/edit execution, workspace mutation, command output, and final model
continuation.
