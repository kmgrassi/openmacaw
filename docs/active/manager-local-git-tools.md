# Manager agent runs `git.run` on the helper (milestone 2)

Follow-up to [`local-model-helper-git-tools.md`](local-model-helper-git-tools.md)
(merged in #158), which let **gateway / coding** local-model agents run
`git`/`gh` on the user's machine. This extends the same capability to the
**manager** agent.

## Why the manager needs a different change

The gateway path is `cloud_managed`: the orchestrator runs the tool-calling
loop and the `ToolExecutionDispatcher` delegates `execution_kind: helper` tools
to the helper via a `tool_execution_request` frame, awaiting a
`tool_call_result`.

The manager is `runtime_managed`
([`manager/model_client/local_relay.ex`](../../runtime/apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex)):
the helper runs the model loop and **forwards** tool calls to the orchestrator,
which executes them in-process via `LlmToolRunner.execute_tool/3`
([`runner/llm_tool_runner.ex`](../../runtime/apps/orchestrator/lib/symphony_elixir/runner/llm_tool_runner.ex))
and sends outputs back. So the manager's `git.run` runs in the AWS orchestrator
(no laptop filesystem / `gh` auth) → `workspace_root_not_found`. The manager
already *has* `git.run` (it is in the `:manager` bundle); the gap is purely
**where it executes**.

The helper already does the right thing: in `runtime_managed` it forwards
`execution_kind: helper` tools to the runtime rather than executing them
(confirmed by `TestDispatchRuntimeManagedDelegatesHelperTool`). The missing
piece is on the **runtime side** — the manager's tool loop must *delegate*
helper-kind tools back to the helper instead of running them locally.

## Design: delegate helper-kind tools from the manager loop

1. **Mark `git.run` as `execution_kind: helper`** in the manager's tool
   definitions ([`manager/model_client/local_relay.ex`](../../runtime/apps/orchestrator/lib/symphony_elixir/manager/model_client/local_relay.ex)),
   mirroring `chat_runner`'s `local_relay_config` from #158. *(Done in this
   branch.)* This is the signal `execute_tool` uses to decide delegate-vs-run.

2. **Delegate helper-kind tools to the helper from `LlmToolRunner.execute_tool/3`.**
   For a tool whose `execution_kind` is `helper`, instead of
   `ToolRegistry.execute` (in-orchestrator), send a `tool_execution_request`
   over the relay and await the `tool_call_result` — exactly what
   `ToolExecutionDispatcher.request_helper_tool_execution/3` does for the
   gateway. Non-helper manager tools (snooze, dispatch_runner, …) keep running
   in the orchestrator.

### The hard part: relay correlation

`Registry.send_tool_execution_request(correlation_id, frame)` requires the
manager's **active relay correlation** (the open helper session is keyed by it,
and the `tool_call_result` is routed back to that session's caller process).
Today the correlation lives inside `ModelClient.LocalRelay` / `LocalRelay.Session`
and is not exposed to `LlmToolRunner.execute_tool/3`. Milestone 2 must thread
the live correlation into the tool loop (e.g. stash it in the session `Agent`
state when `create_response` dispatches) so `execute_tool` can delegate on the
same session the helper is still awaiting `follow_up` on. Getting this lifecycle
right (which correlation is pending between the model turn and the follow-up,
and that `execute_tool` runs in the caller process) is the core risk and must be
proven with the local-stack E2E run.

## Status in this branch

- ✅ `git.run` marked `execution_kind: helper` in the manager dispatch.
- ⏳ `execute_tool` relay delegation + correlation threading — the core change,
  to implement and verify next.

## Verification

Same as #158's milestone 1: a full local-stack E2E run (orchestrator + real
helper with `--workspace-root` + Ollama) driving the manager scheduler against a
real repo, plus a production check after deploy.
