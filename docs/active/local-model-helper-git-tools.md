# Local-model agents run `git.run` on the helper (local CLI auth)

## Goal

A **local-model** agent should run command-line tools (`git`/`gh`) **on the
user's machine**, using that machine's own CLI auth (e.g. the laptop's `gh`
login) — while a **cloud-model** agent keeps running tools in the cloud with
cloud auth. Tool execution + auth should follow the model.

Motivating case: connect the production app to a local Ollama model and have an
agent list/triage PRs (`gh pr list -R owner/repo`) using the developer's local
`gh` session.

## Why it doesn't work today

Model **inference** already relays to the laptop helper. Tool **execution** does
not:

- `git.run` is hardcoded `execution_kind: :runtime`
  ([`tools/git_run.ex`](../../runtime/apps/orchestrator/lib/symphony_elixir/tools/git_run.ex)),
  so the cloud orchestrator runs it. In production that container has neither
  the laptop's `gh` auth nor its filesystem → `workspace_root_not_found`.
- The gateway local-relay path
  ([`gateway/chat_runner.ex`](../../runtime/apps/orchestrator/lib/symphony_elixir/gateway/chat_runner.ex)
  `local_relay_config`) sends only the `:universal` tool bundle, which does not
  include `git.run`, so the model is never even offered the tool.
- The cloud loop **already** supports delegating a tool to the helper by
  `execution_kind` (`tool_execution_dispatcher.ex` →
  `request_helper_tool_execution` → `Registry.send_tool_execution_request`,
  awaiting a `tool_call_result`). The Go protocol layer already defines the
  `tool_execution_request` / `tool_call_result` frames. But the **helper never
  routes the inbound `tool_execution_request`** to its local executor — the
  one genuinely missing component.

## Change (milestone 1 — gateway / interactive coding agent)

1. **Helper (Go).** `relay.Dispatcher` gains an optional `ToolExecutor`; its
   `HandleFrame` routes `*protocol.ToolExecutionRequestFrame` to the existing
   local executor (`internal/tools/local_executor.go`, which already runs
   `git`/`gh` in the configured `workspace_root`) and replies with a
   `tool_call_result` frame. Wired in `cmd/local-runtime-helper/main.go` from
   the same `workspace_root`-derived executor already passed to the runner.
2. **Runtime (Elixir).** For local-relay agents, `local_relay_config` includes
   `git.run` in the dispatched tool definitions and marks its `execution_kind`
   as `helper`, so the cloud loop delegates it to the laptop. Cloud-model
   agents are untouched (`git.run` stays `:runtime`).
3. **Config.** The helper must be registered with `--workspace-root` (the
   local executor is only constructed when `[machine] workspace_root` is set).

End-to-end proof: chat a local-model coding agent "list the open PRs in
`owner/repo`"; the helper runs `gh pr list` on the laptop with the local `gh`
session; `ollama ps` shows the model loaded for the turn.

## Follow-up (milestone 2 — manager agent)

The manager already offers `git.run` (it's in the `:manager` bundle) but runs
its own `runtime_managed` tool loop
([`manager/model_client/local_relay.ex`](../../runtime/apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex))
separate from the cloud `tool_execution_dispatcher`. Routing the manager's
`git.run` to the helper is a separate change tracked here for after milestone 1
lands and is proven interactively.
