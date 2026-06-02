# Model-Agnostic Smoke Harness

This fixture covers the PR 11 platform-side smoke path without live provider
calls:

1. Planning Agent resolves an execution profile for provider A.
2. Planning Agent creates a plan draft fixture.
3. User approval selects tasks from that plan.
4. Coding Agent resolves a different execution profile for provider B.
5. Coding Agent receives the structured handoff payload.

## Local API

Run the API and call:

```sh
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "http://127.0.0.1:3100/api/smoke/model-agnostic-handoff"
```

The response is deterministic and sets `liveProviderCalls` to `false`. It
includes execution profile names, provider adapter names, provider/model labels,
the selected task handoff, and sanitized log lines. It never returns credential
secrets.

Browser tests can load the same fixture from Settings -> Agents -> Model-Agnostic
Smoke and assert that the Planning Agent and Coding Agent show different
provider/model settings.

Optional visible settings can be overridden for browser assertions:

```sh
curl -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "http://127.0.0.1:3100/api/smoke/model-agnostic-handoff?planningProvider=openrouter&planningModel=openrouter/planner&codingProvider=openclaw&codingModel=openclaw/local"
```

Secret-like override values are ignored and replaced with fixture defaults.
