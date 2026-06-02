# Manager Agent Local Smoke

This smoke path verifies the browser-first Manager Agent flow without requiring
manual SQL or IEx.

## Automated Fixture

Run the API smoke tests:

```sh
pnpm -C apps/api test -- manager-agent-smoke setup
```

The fixture endpoint is:

```text
GET /api/smoke/manager-agent
```

It returns a deterministic, secret-free flow:

1. Auth bootstrap creates Planning, Coding, and Manager agents.
2. A workspace credential alias is attached to the manager execution profile.
3. The runtime scheduler sees one due work item.
4. The manager records one reconciliation decision.
5. Status moves from `idle_awaiting_credential` to `not_running` to `running`.

The fixture does not make live provider calls.

## Browser Flow

1. Start local Supabase, the platform API, web app, and orchestrator runtime.
2. Open the web app and sign in.
3. Confirm `/api/auth/state` includes `manager_agent.agent_id`.
4. Attach or reuse a workspace credential for the Manager Agent.
5. Create or seed one ready work item.
6. Wait for the manager scheduler tick.
7. Verify the browser status reaches `running` with a non-zero decision count.
