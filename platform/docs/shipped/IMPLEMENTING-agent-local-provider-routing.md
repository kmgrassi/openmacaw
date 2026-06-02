# Implementing — Agent provider/model selection UI

This branch implements **PR1** from
[docs/local-model-readiness-platform-prs.md](local-model-readiness-platform-prs.md).

## Goal

Today the manager has provider selection on `/settings/manager`.
Planner and coding agents are configured exclusively via the
workspace gateway-config blob — there is no UI to point a planner or
coding agent at a local model, even though the runtime fully
supports it.

This PR adds provider/model/credential selection to the agent
settings page so users can switch any agent — planner, coding, or
manager — between hosted and local execution from the UI.

## Independent of

- [#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363)
  agent tool data model overhaul. Provider/model/credential selection
  is orthogonal to which tools an agent has.

## Depends on

- Runtime PR1 (parallel-agent-runtime#259) — capability mismatch fix.
  Without it, newly-configured local managers will see successful
  saves but `:capability_missing` failures at runtime.

## Files to touch

### Backend (API)

- `apps/api/src/routes/agent.ts` — new endpoints:
  - `GET /api/agents/:id/runtime-profile`
  - `PUT /api/agents/:id/runtime-profile`
- `apps/api/src/services/agent-runtime-profile.ts` (new) — resolves
  and persists per-agent runtime profile. For planner:
  `runners.planner.<agent_id>.{provider, model, credential_id}`.
  For coding: `runners.coding.<agent_id>.{...}`.
- `contracts/agent.ts` — add `AgentRuntimeProfileSchema`.

### Frontend (web)

- `apps/web/src/components/agents/AgentSettingsPanel.tsx` (or
  equivalent) — "Runtime" section: provider select, model input,
  credential selector.
- `apps/web/src/api/agents.ts` — client functions.

## Validation rules

- `provider: "local"` requires a registered local helper machine
  for the workspace. Surface a warning + link to
  `/settings/local-models` when no helper is registered.
- Hosted providers require a credential. Use the existing credential
  selector pattern from the manager activation form.
- Validate `provider` against the runtime allowlist (pull from
  `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/execution_profile.ex`).

## Acceptance criteria

- [ ] User can change a planner agent's provider to `local`; the
  change persists; the agent's next planning turn dispatches through
  the local helper.
- [ ] Same for coding agents using `Runner.LocalModelCoding`.
- [ ] Manager provider selection on `/settings/manager` continues
  to work as before.
- [ ] Saving an unsupported provider returns 400 with a clear error.
- [ ] Saving `provider: "local"` without a registered helper shows
  a warning with a fix-it link, but allows the save.

## Validation

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
```
