# Large File Refactor — Parallel PR Plan

Status: active scoping. Refreshed 2026-05-14.

This document supersedes the earlier 2026-05-08 large-file plan. Several
targets from that plan have already been split (`ManagerAgentSection`,
`AgentDetail`, `agent-tools`, `agent-dashboard`, `local-runtime` helpers, and
the setup store), so this pass focuses on the current largest hand-authored
files that still mix multiple concerns.

The goal is to give parallel agents isolated PR-sized assignments. Each PR
below names one primary file, the intended new helper/component files, and the
validation that should run before merge.

## Ground Rules

- Keep each PR behavior-preserving. Move code, extract helpers, and tighten
  names, but do not change request/response shapes or UI behavior.
- Do not introduce compatibility shims. If a helper exposes a new shape, update
  every local caller in the same PR.
- Keep write ownership disjoint. A PR should touch its primary file, its new
  sibling files, and tests only when imports or fixture placement require it.
- Prefer folder splits for React components and service-domain splits for API
  code. Avoid generic `utils.ts` catch-alls when a more specific helper name is
  obvious.

## Current Survey

Line counts were gathered on 2026-05-14 with generated files, lockfiles, and
test files excluded from the ranking. Test files are mentioned only as likely
validation surfaces.

| PR | File | Lines | Why it is ripe |
| --- | --- | ---: | --- |
| 1 | [apps/web/src/components/settings/RuntimeSection.tsx](../../apps/web/src/components/settings/RuntimeSection.tsx) | 688 | Runtime sessions, helper status, launch controls, and formatting all live in one component. |
| 2 | [apps/web/src/components/settings/LocalModelsSection.tsx](../../apps/web/src/components/settings/LocalModelsSection.tsx) | 652 | The first split landed, but the parent still owns wizard state, binding UI, summary UI, and orchestration. |
| 3 | [apps/api/src/routes/stored-agent-credentials.ts](../../apps/api/src/routes/stored-agent-credentials.ts) | 604 | Route registration, workspace authorization, credential reference parsing, and launcher activation are interleaved. |
| 4 | [apps/api/src/services/local-runtime-machines.ts](../../apps/api/src/services/local-runtime-machines.ts) | 599 | CRUD, revocation, probing, routing-rule cleanup, and response mapping are still in one service facade. |
| 5 | [apps/api/src/services/setup/builders.ts](../../apps/api/src/services/setup/builders.ts) | 578 | Gateway config building, repair logic, requirement status, checklist construction, and diff summaries share one file. |
| 6 | [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx) | 513 | Navigation layout, agent metadata formatting, missing-config state, and settings section definitions are coupled. |
| 7 | [apps/web/src/pages/plans/NewPlan.tsx](../../apps/web/src/pages/plans/NewPlan.tsx) | 505 | Draft validation, label parsing, task editing, and submit flow are all local to one page. |
| 8 | [apps/api/src/routes/local-model-proxy.ts](../../apps/api/src/routes/local-model-proxy.ts) | 502 | Local endpoint resolution, prompt fallback construction, SSE streaming, and tool-loop orchestration are mixed in one route. |
| 9 | [apps/api/src/services/setup.ts](../../apps/api/src/services/setup.ts) | 494 | Public setup operations remain in one orchestration file with nested `*Impl` functions. |
| 10 | [apps/api/src/services/execution-profile-resolver.ts](../../apps/api/src/services/execution-profile-resolver.ts) | 475 | The routing-rule, credential, gateway-config, and fallback resolution chain is dense enough to hide policy bugs. |

Not selected for this pass:

- `apps/api/scripts/agent-test-state.ts` (560 lines): large, but it is a
  developer script rather than app runtime code.
- `apps/api/src/repositories/agents.ts` (538 lines): cohesive repository
  surface; splitting by CRUD verb would add ceremony with little gain.
- Large tests over 500 lines: useful follow-up targets after their production
  seams settle.

## Validation Per PR

Run from repo root before each PR is marked complete:

```bash
pnpm -C apps/api run validate
pnpm exec tsc --noEmit -p apps/web/tsconfig.app.json
pnpm -C packages/plan-schema run test  # only if plan-schema changed
```

For UI PRs (PR1, PR2, PR6, PR7), also run `pnpm run dev`, open
`http://localhost:5173`, sign in with the dev credentials button, exercise the
touched screen, and check the browser console.

For API route PRs (PR3, PR8), also start `pnpm run dev`, hit the touched
endpoint with `curl`, and check `.run-logs/api.log`.

---

## PR1 — Split `RuntimeSection.tsx`

**Primary file:** [apps/web/src/components/settings/RuntimeSection.tsx](../../apps/web/src/components/settings/RuntimeSection.tsx)

**Write ownership:**

- `apps/web/src/components/settings/RuntimeSection.tsx`
- `apps/web/src/components/settings/RuntimeSection/*`

**Proposed split:**

- `RuntimeSection/formatters.ts` — `formatDateTime`,
  `formatSessionTime`, `formatStatusLabel`, `formatExitStatus`, and badge
  variant helpers.
- `RuntimeSection/useWorkerSessions.ts` — `loadWorkerSessionDetails`,
  refresh state, and polling/refresh handlers.
- `RuntimeSection/WorkerSessionTable.tsx` — worker bridge session list.
- `RuntimeSection/RuntimeStatusPanel.tsx` — API/runtime status display.
- `RuntimeSection/RuntimeActionsPanel.tsx` — launch/restart/stop actions.

**Acceptance checks:**

- Runtime status still loads.
- Worker session rows still show the same status and timestamps.
- Launch/restart/stop buttons keep their previous enabled/disabled states.

**Risk:** Medium. This screen is operational and can hide stale polling bugs.

---

## PR2 — Finish Splitting `LocalModelsSection.tsx`

**Primary file:** [apps/web/src/components/settings/LocalModelsSection.tsx](../../apps/web/src/components/settings/LocalModelsSection.tsx)

**Write ownership:**

- `apps/web/src/components/settings/LocalModelsSection.tsx`
- `apps/web/src/components/settings/LocalModelsSection/*`

**Proposed split:**

- `LocalModelsSection/wizard-state.ts` — `WizardState`,
  `wizardStateFor`, and wizard step metadata.
- `LocalModelsSection/WizardSteps.tsx` — progress step rendering.
- `LocalModelsSection/ModelStatusCard.tsx` — local model connection state.
- `LocalModelsSection/BindingPanel.tsx` — agent binding controls.
- `LocalModelsSection/BoundSummary.tsx` — post-bind summary state.
- `LocalModelsSection/useLocalModelsPage.ts` — page-level load, bind,
  refresh, and error state.

**Acceptance checks:**

- Register/probe flow still works.
- Binding an agent to a local model still updates the summary.
- Empty, waiting, connected, and bound wizard states render correctly.

**Risk:** Medium. The existing first split leaves shared state in the parent;
avoid moving state into children unless the ownership is obvious.

---

## PR3 — Split `stored-agent-credentials.ts`

**Primary file:** [apps/api/src/routes/stored-agent-credentials.ts](../../apps/api/src/routes/stored-agent-credentials.ts)

**Write ownership:**

- `apps/api/src/routes/stored-agent-credentials.ts`
- `apps/api/src/routes/stored-agent-credentials/*` or
  `apps/api/src/services/stored-agent-credentials/*`
- Related route tests only if imports or helper coverage require it.

**Proposed split:**

- `routes/stored-agent-credentials/authz.ts` —
  `assertCredentialReferenceBelongsToWorkspace` and workspace ownership checks.
- `routes/stored-agent-credentials/request-parsers.ts` — route param/body
  parsing that wraps existing contract schemas without changing API shapes.
- `services/stored-agent-credentials/activation.ts` — launcher activation and
  credential attachment flows.
- `services/stored-agent-credentials/responses.ts` — response mapping helpers
  that convert DB/service rows to contract responses.
- Keep `registerStoredAgentCredentialRoutes` as a thin route manifest.

**Acceptance checks:**

- Existing route tests pass.
- Manual curl for attach/update/remove credential paths returns the same
  response body shape.
- Supabase errors continue to use `assertSupabaseSuccess()` where applicable.

**Risk:** Medium-high. This is a boundary route for credential state; keep the
Zod contract imports exactly at the HTTP boundary.

---

## PR4 — Thin `local-runtime-machines.ts`

**Primary file:** [apps/api/src/services/local-runtime-machines.ts](../../apps/api/src/services/local-runtime-machines.ts)

**Write ownership:**

- `apps/api/src/services/local-runtime-machines.ts`
- `apps/api/src/services/local-runtime/*`
- `apps/api/src/services/local-runtime-machines.test.ts` only for import or
  fixture placement changes.

**Proposed split:**

- `local-runtime/revocation.ts` — `revokeLocalRuntimeMachines`,
  `revokeOtherWorkspaceMachines`, and
  `unreferencedMachineIdsAfterLocalModelDelete`.
- `local-runtime/probing.ts` — model list URL construction and probe flows.
- `local-runtime/routing-rules.ts` — local model routing-rule creation,
  lookup, deletion, and runner-kind filtering.
- `local-runtime/responses.ts` — row-to-contract response helpers, building on
  the existing `mappers.ts` where possible.
- Keep `local-runtime-machines.ts` as the public facade for the route layer.

**Acceptance checks:**

- Token generation and hashing remain byte-for-byte unchanged.
- Register, list, probe, rotate, and delete tests pass.
- Deleting a model still revokes only unreferenced machines.

**Risk:** Medium. The service already has a partial split; do not duplicate
helpers that belong in the existing `tokens.ts`, `config-snippet.ts`, or
`mappers.ts`.

---

## PR5 — Split `setup/builders.ts` By Builder Domain

**Primary file:** [apps/api/src/services/setup/builders.ts](../../apps/api/src/services/setup/builders.ts)

**Write ownership:**

- `apps/api/src/services/setup/builders.ts`
- `apps/api/src/services/setup/builders/*`
- `apps/api/src/services/setup/builders.test.ts` only for import changes.

**Proposed split:**

- `setup/builders/json.ts` — `stableJson`, `sortValue`, `hashConfig`,
  `asJson`.
- `setup/builders/tool-policy.ts` — default tool policies and
  `buildToolPolicy`.
- `setup/builders/gateway-config.ts` — `defaultAgentGatewayConfig`,
  custom target helpers, runner defaults, `buildGatewayConfig`,
  `repairGatewayConfig`, and `repairManagerGatewayConfig`.
- `setup/builders/credentials.ts` — `buildCredentialJson`.
- `setup/builders/checklist.ts` — requirement status and configuration
  checklist helpers.
- `setup/builders/change-summary.ts` — `buildChangeSummary`.
- Leave `builders.ts` as a barrel or facade so existing imports can migrate
  mechanically within the PR.

**Acceptance checks:**

- `setup/builders.test.ts`, `setup.test.ts`, and `setup.e2e.test.ts` pass.
- Hashes for unchanged gateway config inputs do not change.
- Checklist output stays identical for missing credential/model/runtime cases.

**Risk:** Medium. Hashing and stable JSON order are behavior-sensitive.

---

## PR6 — Extract `AppShell` Navigation Helpers

**Primary file:** [apps/web/src/components/AppShell.tsx](../../apps/web/src/components/AppShell.tsx)

**Write ownership:**

- `apps/web/src/components/AppShell.tsx`
- `apps/web/src/components/AppShell/*`

**Proposed split:**

- `AppShell/settings-sections.ts` — `SETTINGS_SECTIONS` and settings-section
  labels.
- `AppShell/agent-metadata.ts` — `formatAgentType`,
  `formatAgentMetadata`, `formatMissingConfiguration`, and
  `agentMissingConfiguration`.
- `AppShell/NavItem.tsx` — existing navigation item component.
- `AppShell/AgentSwitcher.tsx` — agent list/dropdown rendering if currently
  embedded in the shell body.
- Keep `AppShell.tsx` focused on layout composition and routing.

**Acceptance checks:**

- All nav links still route to the same paths.
- Missing-configuration labels are unchanged.
- Focus mode still hides the same shell chrome.

**Risk:** Low-medium. Mostly view extraction, but the shell is globally visible.

---

## PR7 — Split `NewPlan.tsx`

**Primary file:** [apps/web/src/pages/plans/NewPlan.tsx](../../apps/web/src/pages/plans/NewPlan.tsx)

**Write ownership:**

- `apps/web/src/pages/plans/NewPlan.tsx`
- `apps/web/src/pages/plans/NewPlan/*`

**Proposed split:**

- `NewPlan/draft.ts` — `nextTaskId`, `emptyTask`, label parsing, draft
  validation, and task error helpers.
- `NewPlan/TaskEditor.tsx` — the existing inline task editor.
- `NewPlan/PlanMetadataFields.tsx` — title, description, labels, and
  workspace metadata fields.
- `NewPlan/usePlanDraftSubmit.ts` — submit handler, request construction, and
  navigation after create.
- Keep `NewPlan.tsx` as the page-level state owner and composition root.

**Acceptance checks:**

- Creating a valid plan still navigates to the expected destination.
- Invalid labels and invalid task drafts show the same validation messages.
- Adding/removing/reordering tasks behaves unchanged.

**Risk:** Medium. This is user-facing form logic; keep validation pure and
covered by a small unit test if one does not already exist.

---

## PR8 — Split `local-model-proxy.ts`

**Primary file:** [apps/api/src/routes/local-model-proxy.ts](../../apps/api/src/routes/local-model-proxy.ts)

**Write ownership:**

- `apps/api/src/routes/local-model-proxy.ts`
- `apps/api/src/services/local-model-proxy/*`
- `apps/api/src/routes/local-model-proxy.test.ts` only where needed.

**Proposed split:**

- `services/local-model-proxy/endpoint.ts` — local endpoint and workspace-root
  resolution.
- `services/local-model-proxy/messages.ts` — prompt fallback messages, runtime
  context message construction, and tool-call message shaping.
- `services/local-model-proxy/upstream.ts` — upstream fetch and response
  parsing.
- `services/local-model-proxy/streaming.ts` — completion-to-SSE conversion and
  streaming pipe helpers.
- `services/local-model-proxy/tool-loop.ts` — `chatWithTools` orchestration and
  max-iteration handling.
- Keep the route file as request parsing, response dispatch, and route
  registration.

**Acceptance checks:**

- Non-streaming and streaming completions still return the same shape.
- Tool-call fallback still injects runtime context once.
- Max tool iteration validation remains unchanged.

**Risk:** High. Streaming response handling is easy to subtly alter; preserve
headers and chunk order exactly.

---

## PR9 — Split `setup.ts` Orchestration

**Primary file:** [apps/api/src/services/setup.ts](../../apps/api/src/services/setup.ts)

**Write ownership:**

- `apps/api/src/services/setup.ts`
- `apps/api/src/services/setup/orchestration/*`
- Setup service tests only for imports or new focused helper tests.

**Proposed split:**

- `setup/orchestration/assemble.ts` — `assembleSetup` and local helper
  functions that derive execution-target readiness.
- `setup/orchestration/configure-credentials.ts` —
  `configureSetupAgentCredentials` and its implementation helper.
- `setup/orchestration/configure-tracker.ts` — `configureAgentTracker` and its
  implementation helper.
- `setup/orchestration/create.ts` — `createSetupImpl`.
- `setup/orchestration/read.ts` — `getSetupImpl` and `getAgentHealthImpl`.
- `setup/orchestration/update.ts` — `updateSetupImpl`.
- Keep `setup.ts` as the public export surface used by routes.

**Acceptance checks:**

- `apps/api/src/services/setup.test.ts` and `apps/api/src/setup.e2e.test.ts`
  pass.
- Create, update, read, health, credential activation, and tracker configure
  flows still return the same response shape.

**Risk:** Medium-high. This is core bootstrap behavior; keep transaction and
side-effect ordering unchanged.

---

## PR10 — Make `execution-profile-resolver.ts` Step-Oriented

**Primary file:** [apps/api/src/services/execution-profile-resolver.ts](../../apps/api/src/services/execution-profile-resolver.ts)

**Write ownership:**

- `apps/api/src/services/execution-profile-resolver.ts`
- `apps/api/src/services/execution-profile-resolver/*`
- `apps/api/src/services/execution-profile-resolver.test.ts`

**Proposed split:**

- `execution-profile-resolver/queries.ts` — agent, gateway config, routing
  rule, rule match, credential alias, and credential-scope reads.
- `execution-profile-resolver/routing-rules.ts` — `matchValue`,
  `isRoutingMetadataMatch`, `selectRoutingRule`, and rule-chain resolution.
- `execution-profile-resolver/gateway-runner.ts` — `firstGatewayRunner` and
  legacy credential reference interpretation.
- `execution-profile-resolver/credential-state.ts` — manager/planner
  credentialless policy and scoped credential checks.
- `execution-profile-resolver/build-resolution.ts` — construction of the final
  `ExecutionProfileResolution`.
- Optionally introduce an internal `ResolutionStep` array only if it reduces
  branching without changing priority order.

**Acceptance checks:**

- `execution-profile-resolver.test.ts` passes unchanged or with scenario-only
  fixture moves.
- Routing-rule priority, metadata matching, credential alias resolution, and
  gateway-config fallback order are identical.
- No hardcoded model or credential defaults are introduced.

**Risk:** High. Resolution order is product behavior; tests should prove the
same fallback chain before and after extraction.

## Parallelization Map

These PRs can run at the same time with low conflict risk:

- UI settings: PR1 and PR2 can run in parallel, but both touch nearby settings
  imports, so avoid shared barrel rewrites.
- API local model work: PR4 and PR8 can run in parallel if PR4 stays in
  `services/local-runtime/*` and PR8 stays in `services/local-model-proxy/*`.
- Setup work: PR5 and PR9 should not run in parallel unless agents coordinate
  exports from `services/setup/builders.ts`.
- Independent UI pages: PR6 and PR7 can run in parallel.
- Resolver work: PR10 is independent, but it should avoid opportunistic edits
  to routing-rule repositories or setup code.

Recommended first wave: PR1, PR3, PR5, PR6, PR8, and PR10. Recommended second
wave: PR2, PR4, PR7, and PR9 after nearby imports settle.
