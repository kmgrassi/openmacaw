# Codex OAuth Coding Agent

This is the supported path for running a coding agent through ChatGPT/Codex
OAuth instead of a user-supplied OpenAI API key.

## Runtime Contract

1. The user connects ChatGPT from the credentials UI.
2. The API runs the OpenAI Codex device-code OAuth flow.
3. The API stores an agent-scoped credential row with:
   - `provider = openai_codex`
   - `key_value.access_token`
   - `key_value.refresh_token`
   - `key_value.expires_at`
4. The API syncs the agent routing rule to:
   - `runner_kind = codex`
   - `provider = openai_codex`
   - `credential_id = <credential row id>`
5. Before launch, the API refreshes the OAuth access token when needed.
6. The API calls the runtime worker bridge with:
   - `kind = codex`
   - `credentials.OPENAI_API_KEY.source = inline`
   - `credentials.OPENAI_API_KEY.value = <fresh OAuth access token>`
7. The runtime starts `codex app-server` with that credential in the worker
   environment.

The stored ChatGPT OAuth token is intentionally not exposed to prompts, tool
arguments, logs, or browser responses. The browser only receives redacted
credential metadata.

## Not The API-Key Path

The injected environment variable is named `OPENAI_API_KEY` because the Codex
worker integration consumes that variable today. For `provider = openai_codex`,
the value is a refreshed ChatGPT OAuth access token, not a user-supplied OpenAI
API key.

The current implementation also does not synthesize a `~/.codex/auth.json` file
from the stored credential. The platform owns token persistence and refresh,
then hands the fresh access token to the Codex worker at launch.

## Readiness Checks

For an agent, call:

```bash
curl "$API_BASE_URL/api/diagnostic/agents/$AGENT_ID?workspaceId=$WORKSPACE_ID" \
  -H "authorization: Bearer $SUPABASE_ACCESS_TOKEN"
```

The response includes `codexOAuth` when the resolved profile is a Codex OAuth
profile. A ready result has:

- `codexOAuth.status = "ready"`
- `codexOAuth.runnerKind = "codex"`
- `codexOAuth.provider = "openai_codex"`
- `codexOAuth.credential.ready = true`
- `codexOAuth.credential.token.present = true`
- `codexOAuth.runtimeBridge.credentialEnv = "OPENAI_API_KEY"`

In the web UI, open **Settings -> Runtime** for the agent and check the
**Codex OAuth diagnostics** card.

## Live Smoke

Use this after changing OAuth, credential persistence, routing, launcher
activation, or the Codex worker bridge.

1. Start the runtime launcher.
2. Start the platform API and web app.
3. Sign in to the platform.
4. Open the coding agent's credentials editor.
5. Click **Connect ChatGPT** and complete the device-code flow.
6. Confirm the diagnostic card reports `ready`.
7. Launch the coding agent against a disposable workspace.
8. Ask the agent to make a trivial file edit.
9. Confirm the worker bridge session shows `kind = codex` and
   `credential_keys` includes `OPENAI_API_KEY`.
10. Confirm no OpenAI API-key credential was required for the run.

If the diagnostic says the token is expired, retry the launch path. Launch
performs refresh before handing the token to the worker; a persistent expired
state means the refresh token is invalid or the upstream OAuth refresh request
failed.
