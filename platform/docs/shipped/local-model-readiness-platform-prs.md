# Local-Model Readiness — Platform PR Plan

Repo: `parallel-agent-platform` (TypeScript API + React UI).

Master design (canonical, cross-repo): [parallel-agent-runtime/docs/local-model-readiness-scope.md](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/local-model-readiness-scope.md).

This is the platform-side mirror of the per-repo PR plan.

> **Relationship to [#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363) (agent tool data model overhaul):**
> the overhaul owns tool resolution and per-agent tool-policy UI.
> This readiness scope owns provider/model/credential selection and
> is orthogonal — the two flows can ship in either order.

---

## PR1 — Provider selection UI for planner and coding agents

**Branch:** `feat/agent-local-provider-routing`

**Goal:** Today the manager has provider selection on
`/settings/manager` (preset for `local`, `openai`, etc.). The planner
and coding agents are configured exclusively via the workspace
gateway-config blob — there is no UI to point a planner or coding
agent at a local model, even though the runtime fully supports it
(via `Planner.ModelClient.LocalRelay` and `Runner.LocalModelCoding`).

This PR adds provider selection to the agent settings page (or a new
section) so users can switch any agent — planner, coding, or
manager — between hosted and local execution from the UI.

**Files (TypeScript API):**

| File | Change |
|---|---|
| `apps/api/src/routes/agent.ts` (or wherever per-agent config is read/written) | New endpoints: `GET /api/agents/:id/runtime-profile` (read provider + model + credential refs), `PUT /api/agents/:id/runtime-profile` (update). |
| `apps/api/src/services/agent-runtime-profile.ts` (new) | Resolves and persists the per-agent runtime profile. For planner: `runners.planner.<agent_id>.{provider, model, credential_id}`. For coding: `runners.coding.<agent_id>.{...}`. Validates `provider` against the runtime allowlist (`openai`, `openai_compatible`, `local`, `anthropic`, etc. — pull from runtime `execution_profile.ex`). |
| `contracts/agent.ts` | Add `AgentRuntimeProfileSchema`. |

**Files (React frontend):**

| File | Change |
|---|---|
| `apps/web/src/components/agents/AgentSettingsPanel.tsx` (new section or new tab) | "Runtime" section: provider select (`local`, `openai`, `openai_compatible`, `anthropic`), model input, credential selector (only required for hosted providers). |
| `apps/web/src/api/agents.ts` | Client functions for the new endpoints. |

**Validation rules:**
- `provider: "local"` requires a local helper machine to be registered
  for the workspace (same precondition the manager UI already checks).
  Surface a warning + link to `/settings/local-models` when no helper
  is registered.
- `provider: "openai"`, `"openai_compatible"`, `"anthropic"` require
  a credential. Use the same credential selector pattern from the
  manager activation form.
- For planner agents, validate the selected model is one the
  `Planner.ModelClient` for that provider supports. The API can call
  the runtime diagnostic endpoint
  (`/api/diagnostic/agents/<agent-id>?workspaceId=...`) for a
  pre-flight check before saving.

**Acceptance criteria:**
- [ ] User can change a planner agent's provider to `local` from the
  agent settings UI; the change persists; the agent's next planning
  turn dispatches through the local helper.
- [ ] User can change a coding agent's provider to `local` from the
  agent settings UI; the change persists; the agent's next coding
  turn uses `Runner.LocalModelCoding`.
- [ ] Manager provider selection on `/settings/manager` continues to
  work as before (this PR does not modify that flow).
- [ ] Saving an unsupported provider returns a 400 with a clear error.
- [ ] Saving `provider: "local"` without a registered helper machine
  shows a warning with a fix-it link, but allows the save.

**Sequencing:** Depends on runtime PR1 (capability mismatch fix) so
that newly-configured local managers actually work. Otherwise users
will see successful saves but `:capability_missing` failures at
runtime.

**Independent of the tool data model overhaul ([#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363)):**
provider/model/credential selection is orthogonal to which tools
the agent has. The two flows can ship in either order.

**Size:** ~200 lines API + ~250 lines UI + ~80 lines contracts/tests.

---

## PR2 — Per-agent settings UI for planner and coding — **DROPPED**

This item is **dropped** from the local-model readiness scope. The
agent tool data model overhaul ([#363](https://github.com/kmgrassi/parallel-agent-platform/pull/363)) owns the
canonical per-agent tool-policy UI in its PLAT-3, with normalized
bundle selection + override management. Building a parallel UI here
would either duplicate or conflict.

If non-tool per-agent runtime knobs (cadence overrides, timeouts,
custom instructions) get added later via runtime PR2's scaffolding,
that UI can land as a separate scoping item then. For now, defer.

---

## What is *not* in scope for this repo

- The capability-mismatch fix lives in the runtime
  ([runtime PR1](local-model-readiness-runtime-prs.md)), not the
  platform. The platform doesn't touch capability negotiation.
- Token validator changes
  ([runtime PR3](local-model-readiness-runtime-prs.md) +
  [harper-server PR1](local-model-readiness-harper-prs.md)) don't
  surface in the platform UI. Token rotation is already exposed on
  `/settings/local-models` (via apps#349).
- End-to-end smoke tests
  ([runtime PR4](local-model-readiness-runtime-prs.md)) live entirely
  in the runtime repo.

## Validation (per repo conventions)

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
```

Plus the browser smoke from `parallel-agent-runtime/CLAUDE.md`:
"Browser Login And Planner Work Item Smoke" exercised against a
local-model planner once PR1 ships.
