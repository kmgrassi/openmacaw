# Agent-Friendly Refactor Targets

A starting list of files that are large, dense, or under-modularized
enough that an LLM agent loading them blows past its useful context
window — or has to re-derive structure that a human author already
holds in their head. Each entry calls out the specific pain and a
concrete first move. None of these are required correctness fixes;
they're ergonomic ones, sized for a single PR each.

The bar for inclusion: the file is over ~400 lines, *or* mixes more
than one bounded concern, *or* has no clear public-vs-private surface
that an agent can latch onto without reading the whole file.

Sizes are LOC at HEAD on `main` as of 2026-04-30.

---

## 1. `apps/api/src/routes/stored-agents.ts` (1,134 LOC)

The biggest non-generated file in the API. One `registerStoredAgentRoutes`
function spans ~650 lines and registers every credential, alias, agent
mutation, and runtime activation route side-by-side. Helpers
(`buildCredentialByRowId`, `runnerKindForAgent`,
`requireCodexProfile`, `managerWorkspaceConfig`) sit at the top of the
file but feed only one or two routes each, so an agent reading any one
route still has to scan the whole file to know which helpers are in
scope.

**First move:** split by domain — `routes/credentials.ts`,
`routes/credential-aliases.ts`, `routes/stored-agents.ts` (CRUD only),
`routes/stored-agent-credentials.ts` (the credential-reference and
launch endpoints). Move helpers next to the only route that uses
them; promote the truly shared ones (`isLauncherError`,
`blockingProfileMissing`) into `services/`.

## 2. `apps/api/src/services/setup.ts` + `services/setup/` (842 + 594 + 529 LOC)

`services/setup.ts` mixes mappers (`mapSetupAgent`,
`mapSetupEngine`, `mapGatewayConfig`, `mapWorkspace`),
side-effecting helpers (`updateAgentModelSettings`,
`createGatewayConfigVersion`), and the public surface
(`createSetup`, `getSetup`, `updateSetup`,
`activateManagerAgentCredentials`, `applyDefaultAgentCredentials`,
…). Each public function reads naturally on its own but they share
the file with ~10 unexported helpers, so jumping into "what does
`activateManagerAgentCredentials` do?" still requires loading
everything.

There's also already a `services/setup/` subdirectory with a
`store.ts` and `builders.ts` that are themselves >500 LOC each. The
split exists but isn't carrying its weight.

**First move:** push the `map*` row→response converters into
`services/setup/mappers.ts` (pure functions, easy to load in
isolation). Carve `gateway-config.ts` and `default-agents.ts` out of
the side-effecting helpers. Leave `services/setup.ts` as a thin
public surface that re-exports.

## 3. `apps/api/src/routes/agent-diagnostic.ts` (801 LOC)

A single route file that builds three different diagnostic
payloads (`buildClaudeCodeDiagnostic`, `buildWorkItemSnoozeDiagnostic`,
`buildBlockers`) plus a probe (`probeOllamaEndpoint`) and a registrar.
The diagnostic builders are independently testable but currently
co-located with the Express handler that calls them.

**First move:** move each `build*Diagnostic` function plus its
helpers into `services/diagnostics/<kind>.ts`. The route file becomes
a ~50-line dispatcher that picks a builder by agent kind. This also
makes it easy to add a new diagnostic without enlarging the route file.

## 4. `apps/api/src/supabase.ts` (761 LOC)

The single hand-written Supabase access module. Mixes auth (token
verification, service-role client construction), repositories
(stored-agent CRUD, credential lookup, agent listing), and
type-shaping helpers. Repository code already lives under
`apps/api/src/repositories/` for newer features, so this file is
effectively the legacy untyped pile.

**First move:** treat each exported function as a candidate to move
into `repositories/<table>.ts` (or `services/` if it spans multiple
tables). Stop adding to `supabase.ts` — make the convention "new
queries go in `repositories/`" explicit in `apps/api/CLAUDE.md`.

## 5. `apps/api/src/routes/proxy.ts` (558 LOC)

Two near-duplicate flows live in this file: `proxyResolvedRuntimeRequest`
(retry-aware proxy to the runtime URL resolved per agent) and the
launcher-direct routes (`/api/agents/:id/start`, remediations,
worker-bridge sessions). They share `runtimeErrorCode` and
`normalizeRuntimeResponse`, but the data flow ("proxy passthrough" vs.
"launch / remediate") is different. The mapper helpers
(`mapAgentControlMessage`, `mapWorkerBridgeSession*`) belong with the
contract they serialize, not in the route file.

**First move:** extract `mapAgentControlMessage` to `services/agent-control.ts`
(where the contract already lives) and the worker-bridge mappers to
`services/worker-bridge.ts`. Split routes into
`routes/agent-proxy.ts` (passthrough) and `routes/agent-control.ts`
(messages, remediations, worker bridge). The `proxyRequest` /
`proxyResolvedRuntimeRequest` helpers stay in a small
`services/agent-proxy-transport.ts`.

## 6. `apps/api/src/routes/local-runtime.ts` (601 LOC)

Five route handlers in one file, each ~80–120 lines, registering
machine lifecycle endpoints (register, list, deregister, helper
lifecycle). Each route inlines its Zod parse, its Supabase write, and
its response shaping. Reading any one route requires scrolling past
the others.

**First move:** lift each route's body into a service function
(`services/local-runtime-machines.ts`,
`services/local-runtime-helpers.ts`) and let the route file shrink to
a registration manifest. Mirrors the shape of newer route files like
`routes/work-items.ts`.

## 7. `apps/web/src/components/settings/AgentModelPolicy.tsx` (677 LOC)

The largest single React component in the codebase. One default-export
function holds the form state, the credential-resolution effect, the
model-list fetch, the rules-toggling state, the validation messages,
and the submit handler. The component file also defines several
sub-components inline (`PolicyRow`, etc.) instead of importing them.

**First move:** pull the credential-resolution effect into a
`useResolvedCredentials` hook in `hooks/`. Lift inline sub-components
(`PolicyRow`, `RuleEditor`) into `settings/agent-model-policy/`.
Keep the page-level form state in the parent; everything else moves
out.

## 8. `apps/web/src/api/broker.ts` + `apps/web/src/api/ws-types.ts` (474 + 540 LOC)

`broker.ts` is the single file every web fetch goes through: auth
header injection, error normalization, retry, and one
`brokerFetch<T>` per resource. `ws-types.ts` is a flat enumeration of
every WebSocket payload type used anywhere in the app. Both files are
imported widely; touching either invalidates a lot of bundles, and
changes here often need to land alongside contract changes in the
monorepo.

**First move:** keep `broker.ts` as the transport core, but move
per-resource fetchers (anything named `fetchAgents`, `createAgent`,
…) into `api/<resource>.ts`. Same idea for `ws-types.ts` — split by
namespace (`ws-types/agent.ts`, `ws-types/runtime.ts`, …) and re-export
a barrel. Agents currently can't tell whether a given function lives
in the transport core or in a thin wrapper.

## 9. `apps/api/src/services/execution-profile-resolver.ts` (481 LOC)

Resolves an execution profile through a sequence of fallbacks:
routing rule → stored agent → gateway config → default. The cascade
is encoded as a single function with deeply nested branches and a
trail of "missing requirement" tags. Adding a new fallback (e.g., for
the container runner from PR
[#298](https://github.com/kmgrassi/parallel-agent-platform/pull/298))
requires understanding the entire cascade.

**First move:** model each resolution layer as an explicit
`ResolutionStep` with a name, a predicate, and a producer. The
top-level function becomes a fold across the steps. This also makes
the `execution_profile_resolution` test file (currently 811 LOC,
mostly fixture variants) easier to write per-step rather than
end-to-end.

## 10. `apps/web/src/components/AgentDashboardPanel.tsx` (525 LOC)

Renders the dashboard panel for any agent kind, switching layouts
based on `agentType` and runner kind. Reads from
`GatewayContext` and the runtime events store, computes diagnostic
state inline, and renders 4–5 different sub-panels with shared
chrome. Changes here regularly cascade across agent types because
the per-kind logic lives in one big switch.

**First move:** split per-kind panels (`CodingAgentDashboard`,
`PlanningAgentDashboard`, `ManagerAgentDashboard`,
`LocalCodingAgentDashboard`) into sibling files. Keep the parent only
for the kind dispatch and shared chrome (header, status pill, error
banner). Each per-kind file then has a single concern an agent can
load on its own.

---

## Bonus / second-tier candidates

If the first ten land cleanly, the next batch worth eyeing:

- `apps/api/src/services/agent-tools.ts` (409 LOC) — tool resolution
  cascade similar in shape to the execution-profile resolver.
- `apps/web/src/context/GatewayContext.tsx` (430 LOC) — provider that
  fans out to every page; mixing wire state with derived selectors.
- `apps/web/src/routes/WorkspaceItems.tsx` (545 LOC) — page component
  with the "monolithic state, inline filters, inline modals" pattern.
- `apps/api/src/setup.e2e.test.ts` (966 LOC) and
  `services/setup.test.ts` (962 LOC) — both are useful tests, but
  splitting them by scenario would make targeted re-runs obvious.
- `apps/web/src/lib/runtime-events.ts` (400 LOC) — event reducer that
  has accreted handlers; would benefit from per-event handler files.

## Suggested cadence

One PR per target, no bundling. Each PR should be a pure refactor
with no behavior change — the validation gate is just
`pnpm -C apps/api run validate` plus the web typecheck. Land target
4 (`supabase.ts`) early so the convention shift to `repositories/` is
in effect before later PRs touch nearby code.
