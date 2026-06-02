# Local Model Coding Smoke

This smoke path covers the platform side of the `local_model_coding` end-to-end
flow without calling a live provider by default. It gives the API, browser, and
runtime repos a shared shape for proving:

```text
Platform profile resolution
  -> Runtime local_model_coding dispatch
  -> Local OpenAI-compatible model tool call
  -> shell.exec / apply_patch tool events
  -> disposable workspace mutation
  -> diff and events visible in Platform
```

## Fixture Endpoint

Start the platform and load the deterministic fixture:

```bash
pnpm run dev
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "http://127.0.0.1:3100/api/smoke/local-model-coding-runner"
```

The response is fixture-backed and must report `"liveProviderCalls": false`.
It intentionally uses a symbolic runtime endpoint, `runtime-local-loopback`,
instead of returning local inference URLs or credentials.

Optional query parameters:

```bash
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "http://127.0.0.1:3100/api/smoke/local-model-coding-runner?model=qwen2.5-coder:latest&approvalPolicy=on-request"
```

Secret-like model values are rejected back to the default fixture model so the
smoke payload can be copied into issues or PRs safely.

## Browser Check

1. Start `pnpm run dev` from the platform repo root.
2. Open `http://localhost:5173`.
3. If redirected to `/login`, click **Use dev credentials**.
4. Open `/settings/agents`.
5. In **Local Model Coding Smoke**, click **Load fixture**.
6. Verify the panel shows:
   - runner kind `local_model_coding`;
   - provider `openai_compatible`;
   - workspace policy `workspace-write`;
   - tool calls for `shell.exec`, `apply_patch`, and `shell.exec`;
   - a diff containing `Local coding smoke passed.`;
   - ordered events from profile resolution through UI readiness.
7. Check the browser console for errors.

## Live Local Smoke

Use this once `parallel-agent-runtime` has the matching runner loop enabled.

1. Start Ollama, LM Studio, vLLM, or another OpenAI-compatible local endpoint.
2. Start `parallel-agent-runtime` in local mode.
3. Create a disposable repo:

   ```bash
   mkdir -p /tmp/local-model-coding-smoke
   cd /tmp/local-model-coding-smoke
   git init
   printf '# Disposable smoke repo\n' > README.md
   git add README.md
   git commit -m 'seed smoke repo'
   ```

4. Dispatch a coding run through the runtime using:
   - runner kind `local_model_coding`;
   - provider `openai_compatible`;
   - model such as `qwen2.5-coder:latest`;
   - tools `shell.exec` and `apply_patch`;
   - sandbox `workspace-write`;
   - approval policy `on-request`.
5. Ask the agent to append `Local coding smoke passed.` to `README.md`.
6. Verify the platform run view or smoke panel surfaces the same classes of
   events as the fixture: profile, runtime dispatch, tool call, file change, and
   diff preview.

## Browser Manual Tool Smoke

This is the manual end-to-end check agents should be able to run with the
standard coding smoke harness and local dev login credentials. It proves the
local-model Coding Agent can receive real user chat, call filesystem tools, and
surface the result in the browser.

Prerequisites:

- Platform web/API are running locally.
- Runtime/helper is running with the local-model coding runner enabled.
- The helper is registered to the disposable workspace root used below
  (`/tmp/local-model-coding-browser-smoke`), not a real project with
  unrelated local changes. If you must use a different workspace root,
  substitute that path everywhere this doc references
  `/tmp/local-model-coding-browser-smoke`.
- A local OpenAI-compatible model endpoint is running.
- Dev login credentials are configured for the local browser flow.

Fixture workspace (must match the path the helper is registered to):

```bash
mkdir -p /tmp/local-model-coding-browser-smoke
cd /tmp/local-model-coding-browser-smoke
git init
printf '# Browser smoke\n\nThe agent should be able to read this file.\n' > README.md
git add README.md
git commit -m 'seed browser smoke repo'
```

Manual flow:

1. Open `http://localhost:5173`.
2. If redirected to `/login`, use the configured dev login credentials.
3. Open the Coding Agent that is configured for the local model runner.
4. Confirm the agent/runtime status shows the local model runner is available.
5. Send a read-only prompt:

   ```text
   Please read README.md in the workspace and tell me the first heading.
   ```

6. Verify the response identifies `# Browser smoke`.
7. Verify the run/tool event UI shows a `shell.exec` tool call for reading or
   inspecting the file, such as `sed -n`, `cat`, `nl`, `rg`, or equivalent.
8. Send a trivial edit prompt:

   ```text
   Add a file named LOCAL_MODEL_SMOKE.md at the workspace root with the text:
   Local model filesystem smoke passed.
   ```

9. Verify the response reports the file was created.
10. Verify the run/tool event UI shows an `apply_patch` tool call for the edit.
11. Verify the file exists on disk:

    ```bash
    test -f /tmp/local-model-coding-browser-smoke/LOCAL_MODEL_SMOKE.md
    cat /tmp/local-model-coding-browser-smoke/LOCAL_MODEL_SMOKE.md
    ```

12. Verify the working tree contains only the expected smoke file:

    ```bash
    cd /tmp/local-model-coding-browser-smoke
    git status --short
    ```

Expected browser-visible evidence:

- The user can log in and reach the local-model Coding Agent.
- The agent receives the message through the normal chat UI.
- The read prompt causes `shell.exec`, not `apply_patch`.
- The edit prompt causes `apply_patch`, not shell redirection or heredoc file
  writes.
- Tool calls, arguments, status, and summarized output are visible in the
  run/chat UI.
- The final file state matches the requested trivial change.

Cleanup:

```bash
rm -rf /tmp/local-model-coding-browser-smoke
```

## Automated Checks

Run the API route test:

```bash
pnpm -C apps/api test -- local-model-coding-smoke
```

Run the required validation before publishing changes:

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
```
