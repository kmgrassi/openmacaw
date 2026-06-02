# Manager chat — multi-turn message history (scope)

## Problem

`Manager.ModelClient.OpenAICompatibleChat.initial_request/3` sends exactly
two messages on every turn:

```elixir
[%{role: "system", content: session.prompt},
 %{role: "user",   content: due_tasks_payload}]
```

There is no carry-over across turns. The model therefore cannot:

- remember anything the user said in the previous chat turn,
- reuse a fact established in an earlier autonomous scheduler tick, or
- answer a clarifying follow-up ("what did you decide last time?") without
  losing the context.

The DB already has the history. `Manager.MessageRecorder.start_run/4` /
`finalize_run/3` (added on PR #291 and #292's follow-ups) persist every
manager turn — user input, assistant output, and tool-call summaries —
to the `message` table, keyed on the `agent:<id>:main` session thread.
Nothing reads them back.

The same gap also applies to the planner and Codex chat runners; this
scope focuses on the manager because that's where the recent UX problem
surfaced. The same approach should generalize.

## Goal

When the manager runs a turn (chat *or* scheduler), include the last N
persisted messages from the `agent:<id>:main` thread in the model
request, in chronological order, immediately after the system prompt.

Default `N = 10`. User-configurable per agent.

v1 ships text-only replay (user + assistant content). Full tool-call /
tool-result replay needs recorder changes and is deliberately deferred
to v2 — see "Tool-call replay" below.

## Non-goals

- Token-budget-aware truncation. Start with a fixed message count; add
  token accounting later if 10 messages routinely overflow the model's
  context.
- Summarisation / "rolling memory" — out of scope here.
- Changing the planner or Codex chat paths. Same idea applies; do those
  as follow-ups once the manager pattern is proven.
- Replaying scheduler turns into chat or vice versa as anything other
  than ordinary messages — they already share the thread, so the
  `agent:<id>:main` read is the integration point.

## Where the config lives

The setting needs to land where the *resolver* for each agent type
already reads its config — otherwise the runtime profile editor write
goes into a slot the runner never looks at. The two paths are
different today:

**Manager** — `Manager.SessionResolver.runnable_config/4` builds the
session from `gateway_config.config_json["runners"]["manager"]` and
adds credentials / user identity. It never touches `agent.model_settings`.
So for the manager, store:

```jsonc
// gateway_config.config_json
{
  "runners": {
    "manager": {
      "provider": "openai_compatible",
      "model": "qwen3-coder:30b",
      "history_window": 10   // 0 disables; null falls back to default
    }
  }
}
```

The platform's `persistWorkspaceManagerGatewayConfig`
(`apps/api/src/services/agent-runtime-profile.ts`, the writer added in
PR #415) already round-trips this object on every runtime-profile
save, so adding a field there is a 1-line change. The runtime profile
editor needs a UI input that writes the field; PR scope.

**Planner / coding agents** — these are dispatched per-agent from
`Gateway.ChatRunner` (`run_planner/5`, `run_local_model_coding/5`),
which already receives the full `agent` struct. For those, the
canonical home is `agent.model_settings.history_window`
(`ModelSettingsSchema` in `contracts/agents.ts` is a
`.catchall(JsonValue)` so the field is additive, no schema break).
Out of scope for this PR — note here so a follow-up doesn't have to
re-derive the answer.

Default when unset: **10**. Hard cap: **50** (prevents pathological
prompts; can be raised later). Both bounds enforced in
`MessageHistory.fetch/2` so a bad config can't crash a turn.

## Runtime read path

New module: `SymphonyElixir.Manager.MessageHistory`.

```elixir
@spec fetch(scope :: map(), opts :: keyword()) :: [%{role: String.t(), content: String.t(), ...}]
def fetch(%{agent_id: _, workspace_id: _, session_key: _} = scope, opts)
```

- Reads from the same `MessageLog` adapter the recorder writes through
  (`Application.get_env(:symphony_elixir, :message_log_adapter, MessageLog)`)
  so tests can stub it the same way.
- Queries the `message` table for the agent's `session_thread`
  (resolved via `MessageLog.upsert_session_thread/2`, same call the
  recorder uses) ordered by `created_at DESC LIMIT N`, then reverses
  to chronological order before returning.
- Excludes the in-flight user message — i.e. the most recent record
  written by `start_run/4` for the current `run_id` — because the
  caller already has that content in `due_tasks_payload`. Cheapest
  check: filter by `run_id != current_run_id`.
- Returns a normalized list of `%{role: "user" | "assistant",
  content: <string>}` shaped for
  `Manager.ModelClient.OpenAICompatibleChat`. `tool_calls` / `tool`
  role messages are intentionally omitted in v1 (see "Tool-call
  replay" — current recorder data is insufficient to reconstruct
  valid replay).

## Plumbing

1. `Manager.SessionResolver` already places `:message_recorder_scope` on
   the session; reuse it as the read key. No new arg to `start_session/2`.
2. `Manager.ModelClient.OpenAICompatibleChat.initial_request/3` becomes:
   ```elixir
   history = MessageHistory.fetch(scope, limit: session.history_window)
   %{
     "model" => session.model,
     "messages" =>
       [%{"role" => "system", "content" => session.prompt}] ++
       history ++
       [%{"role" => "user", "content" => due_tasks_payload}],
     ...
   }
   ```
3. `session.history_window` is set by `Runner.Manager.start_session/2`
   from `config["history_window"]` with a default. The config map
   passed to `start_session/2` is already populated from
   `runners.manager` by `SessionResolver.runnable_config/4`, so once
   the field is written into `runners.manager` (see "Where the config
   lives") it threads through automatically.
4. The `OpenAIResponses` client takes the same change — the manager runs
   under either backend.

## Tool-call replay

**v1 (this PR / immediate follow-up): text-only replay.** Replay only
the user and assistant *text* content. Skip `tool_calls` and `tool`
role messages entirely. Reason: the current recorder is missing the
data needed to reconstruct valid OpenAI-compatible tool history:

- `Manager.MessageRecorder.tool_call_summary/2`
  (`apps/orchestrator/lib/symphony_elixir/manager/message_recorder.ex`)
  retains only `tool` (name), `call_id`, `status`, `error_code`, and
  `retryable`. It drops the tool **arguments** the assistant sent and
  the **output** the tool returned.
- An OpenAI-compatible assistant message with `tool_calls` requires
  `{id, type: "function", function: {name, arguments}}` — we have
  name + id, not arguments. And the matching `tool` role message
  requires `{role: "tool", tool_call_id, content: <output>}` — we
  have the call id, not the output content.
- Emitting partial `tool_calls` without matching `tool` results (or
  with bogus empty-string content) makes Ollama / OpenAI chat
  completions reject the request.

For v1, treat any assistant row with non-empty `metadata.tool_calls`
as: include its `content` text if present; omit the `tool_calls`
field. The model loses awareness that it previously called a tool
(it'll see "I snoozed work item X" in plain text and have to trust
itself), but the alternative is no history at all.

**v2 (follow-up, separate PR): full tool replay.** Extend
`Manager.MessageRecorder` so each turn persists enough to reconstruct
OpenAI-compatible tool history. Concretely:

- In `tool_call_summary/2`, capture the full `arguments` JSON from the
  tool-call event payload alongside name/call_id.
- For `tool_call_completed` / `tool_call_failed` events, persist the
  tool **output** (currently dropped — only the status survives). A
  new `tool_outputs` array on the assistant row's metadata is the
  smallest change; a separate `tool` row per result is the cleaner
  one. Pick during v2 scope.
- Once both land, `MessageHistory.fetch/2` can emit `tool_calls` on
  the assistant message + matching `tool` rows, and drop any
  unmatched pair (mid-loop failures that left the assistant having
  "called" a tool with no result row).

v2 needs its own scoping pass — it touches recorder write semantics
and storage shape — so keeping v1 text-only here keeps this PR
self-contained and unblocks the cross-turn memory improvement
immediately.

## Failure modes

- DB read fails → log + return `[]`. Better to lose memory for one turn
  than to fail the whole chat. `MessageHistory.fetch/2` should never
  raise.
- `history_window` is 0 or negative → return `[]`. Lets a user disable
  history entirely without code changes.
- Empty thread (brand-new agent) → return `[]`.
- Configured value > hard cap → clamp to cap, don't error.

## Testing

- Unit: stub `:message_log_adapter` with a `RecordingAdapter` that
  returns canned rows; assert order, role mapping (user/assistant only
  in v1), exclusion of current run, clamp at limit, drop of any tool
  rows (defense-in-depth in case future recorder writes them).
- Integration: extend `manager_test.exs` so a second `run_chat_turn/4`
  call sees the assistant output from the first via a stub
  `OpenAICompatibleChat` that asserts the request `messages` array
  contains exactly `[system, prior_user, prior_assistant, current_user]`.
- Live: manual smoke — chat "remember the number 7", then "what
  number?". With this change the second response should reference 7.

## Rollout

Two PRs total:

1. **v1 (this scope) — runtime only.** Single runtime PR adding
   `Manager.MessageHistory`, the `runners.manager.history_window`
   read, and the splice in `OpenAICompatibleChat.initial_request/3`
   (and `OpenAIResponses`). Text-only replay. No DB migration. No
   platform code change required — the platform's existing manager
   gateway writer (PR #415's `persistWorkspaceManagerGatewayConfig`)
   just needs to forward the field, which is a one-line addition.
   Default of 10 means users get value without touching settings.
2. **v2 (follow-up) — recorder + tool replay.** Separate PR extending
   `Manager.MessageRecorder` to persist tool arguments + outputs, then
   widening `MessageHistory.fetch/2` to emit `tool_calls` /
   `tool`-role messages. Scoped on its own once v1 lands and there's
   real usage to measure value against the extra recorder complexity.

## Open questions

- Should scheduler ticks see prior chat? Default proposal: yes, because
  the thread is shared and the value is "agent remembers what was
  said." If undesirable, gate the lookup on `work_item.source != "manager"`.
- Token budget. 10 user/assistant text messages fit in any sensible
  context window; with v2's tool replay a long stretch of tool output
  could blow past 32k. v2 should add a configurable
  `history_max_tokens` and truncate from the head (oldest first) when
  exceeded.
- Caching. The DB read happens once per turn. If that becomes a hot
  path, cache the last fetch on the session and append-on-write from
  the recorder. Not needed for v1.
