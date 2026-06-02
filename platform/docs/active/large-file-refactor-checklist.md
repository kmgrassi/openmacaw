# Large File Refactor Checklist

Refreshed on 2026-05-14.

This checklist tracks the active refactor candidates selected in
[large-file-refactor-pr-plan.md](large-file-refactor-pr-plan.md). It is not a
complete "every file over N lines" inventory; generated files, lockfiles, tests,
and cohesive repository modules are intentionally excluded from the active
target list.

## Active Refactor Candidates

- [ ] `apps/web/src/components/settings/RuntimeSection.tsx` - 688 lines.
  Split runtime formatting, worker session loading, status panels, and actions.
- [ ] `apps/web/src/components/settings/LocalModelsSection.tsx` - 652 lines.
  Finish extracting wizard state, model status, binding controls, and summary
  UI after the first split.
- [ ] `apps/api/src/routes/stored-agent-credentials.ts` - 604 lines. Split
  route registration from credential authz, request parsing, activation, and
  response mapping.
- [ ] `apps/api/src/services/local-runtime-machines.ts` - 599 lines. Thin the
  facade by extracting revocation, probing, routing-rule, and response helpers.
- [ ] `apps/api/src/services/setup/builders.ts` - 578 lines. Split JSON/hash,
  tool policy, gateway config, credential, checklist, and change-summary
  builders.
- [ ] `apps/web/src/components/AppShell.tsx` - 513 lines. Extract settings
  section metadata, agent metadata formatting, nav item, and agent switcher UI.
- [ ] `apps/web/src/pages/plans/NewPlan.tsx` - 505 lines. Extract draft
  helpers, task editor, metadata fields, and submit flow.
- [ ] `apps/api/src/routes/local-model-proxy.ts` - 502 lines. Split endpoint
  resolution, message construction, upstream calls, streaming, and tool-loop
  orchestration.
- [ ] `apps/api/src/services/setup.ts` - 494 lines. Split public setup
  orchestration by create/read/update/health/credential/tracker workflow.
- [ ] `apps/api/src/services/execution-profile-resolver.ts` - 475 lines. Split
  queries, routing-rule matching, gateway-runner parsing, credential state, and
  final resolution construction.

## Recently Completed Or Superseded Targets

These were called out by older scoping docs and have since been split or moved
out of the top active set:

- [x] `apps/web/src/components/settings/ManagerAgentSection.tsx`
- [x] `apps/web/src/components/settings/AgentDetail.tsx`
- [x] `apps/api/src/services/agent-tools.ts`
- [x] `apps/api/src/services/agent-dashboard.ts`
- [x] `apps/api/src/services/setup/store.ts`
- [x] `apps/api/src/services/setup.ts` initial split from the former 1,500+
  line setup service
- [x] `apps/api/src/services/model-catalog.ts`
- [x] `apps/api/src/services/work-item-ingest.ts`
- [x] `apps/api/src/ws/orchestrator-proxy.ts`

## Deferred Large Files

- `apps/api/scripts/agent-test-state.ts` - 560 lines. Developer script; defer
  until app runtime refactors land.
- `apps/api/src/repositories/agents.ts` - 538 lines. Cohesive repository
  surface; no split recommended in this pass.
- Large test files such as `setup.e2e.test.ts`,
  `execution-profile-resolver.test.ts`, and `agent-tools.test.ts`. Split only
  after the corresponding production seams stabilize.

## Suggested Order

- [ ] Run the first wave in parallel: `RuntimeSection`, `stored-agent-credentials`,
  `setup/builders`, `AppShell`, `local-model-proxy`, and
  `execution-profile-resolver`.
- [ ] Run the second wave after nearby imports settle: `LocalModelsSection`,
  `local-runtime-machines`, `NewPlan`, and `setup.ts`.
- [ ] Re-run this checklist after those PRs merge and decide whether test files
  or scripts deserve the next pass.
