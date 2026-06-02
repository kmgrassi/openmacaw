# Claude Code Browser Smoke

This smoke covers the platform-side PR 5 acceptance path for dispatching a
Planning Agent work item to a Claude Code coding agent.

## Deterministic Browser Fixture

Run the platform API and web app, log in, then open Settings -> Agents ->
Claude Code Dispatch Smoke and click Load fixture.

The fixture calls:

```sh
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "http://127.0.0.1:3100/api/smoke/claude-code-dispatch"
```

Expected browser-visible evidence:

- planning profile creates `plan-smoke-claude-code-dispatch`
- work item `work-item-claude-code-edit` is assigned to
  `claude-code-coding-agent-smoke`
- runtime profile uses `runner_kind: claude_code`, `provider: anthropic`,
  `model: sonnet`, `credential_ref: credential_alias:anthropic/default`, and
  `tool_profile: coding`
- normalized events include assistant delta, tool start, tool completion, turn
  completion, and usage
- workspace evidence shows completed run logs and a diff summary

The fixture is deterministic and sets `liveProviderCalls` to `false`; it never
returns credential secrets.

Optional visible model override for browser assertions:

```sh
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "http://127.0.0.1:3100/api/smoke/claude-code-dispatch?model=claude-sonnet-4-5"
```

Secret-like override values are ignored and replaced with `sonnet`.

## Live Manual Smoke

Use this checklist once the platform branch is paired with runtime support for
`Runner.ClaudeCode` and the runtime live smoke harness.

1. Start `parallel-agent-runtime` from a branch containing Claude Code runner
   support and bridge event normalization.
2. Start this platform with `pnpm run dev`.
3. Log in to `http://127.0.0.1:5173` with the dev credentials button.
4. Create or select a coding agent configured with:
   - runner: `claude_code`
   - provider: `anthropic`
   - model: `sonnet` or a configured Claude model
   - credential ref: `credential_alias:anthropic/default`
   - tool profile: `coding`
5. Use the Planning Agent to create a plan and one selected work item.
6. Dispatch that work item to the Claude Code coding agent.
7. Confirm the runtime dashboard shows runner `claude_code`, provider
   `anthropic`, streamed assistant/tool events, turn completion, usage, and a
   completed broker run.
8. Confirm the disposable workspace contains the expected diff or command
   output from the coding run.
