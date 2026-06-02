# Unified Execution Profile — Scope

## Goal

Replace today's scattered model / provider / credential / runner-kind
selection with a single canonical value type and a single picker.

Changing where an agent gets its model and credentials from should require:

1. One UI control — a single `ExecutionProfilePicker` that emits the full
   selection in one shot.
2. One write — a single API call that upserts one row.
3. One default — `DEFAULT_EXECUTION_PROFILE_BY_AGENT_TYPE` in
   `contracts/`.

Today it takes four UI controls in three different components, two
storage paths (routing rule + gateway config), and updates in six hardcoded
defaults to swap a default model. This doc proposes a phased
refactor to consolidate.

## Progress so far

A real-world test of the ChatGPT OAuth flow (PR #434) surfaced that
saving a credential or changing a model didn't keep the routing rule in
sync — a coding agent kept routing to its old local-model runner even
after a user connected ChatGPT. We pre-emptively closed that gap before
the full refactor lands:

| Landed       | What it does                                                                                            |
|--------------|---------------------------------------------------------------------------------------------------------|
| **#429** ✅  | `POST /api/stored-agents/:id/credentials` upserts the routing rule via `syncCredentialIntoRoutingRuleForAgent`. |
| **#434** 🟡  | `POST /api/credentials/openai-codex/oauth/poll` calls the same helper after a successful OAuth save.   |
| **#434** 🟡  | `PATCH /api/stored-agents/:id` (model change) calls new `syncModelIntoRoutingRuleForAgent`, which keeps the existing credential ref and updates model + derived provider on the rule. |
| **#434** 🟡  | `syncCredentialIntoRoutingRuleForAgent` now uses `resolveRoutingRuleModelForProvider` so a credential save for a new provider auto-picks a compatible model from the catalog instead of leaving `(provider=openai_codex, model=qwen3-coder:30b)`. |
| **#434** 🟡  | `defaultModelForProvider` + `modelMatchesProvider` added to `contracts/model-catalog.ts`. These reduce the "default model in six places" gap from six to five (the server-side cases share one source of truth). |

These don't replace this scoping doc — they're targeted plumbing fixes
inside today's architecture so the OAuth credential test can pass while
the full refactor is being scoped. **The scoping doc's structural
proposals (one value type, one picker, one matrix, one write, one
default) still apply.** Phase 1 absorbs the catalog helpers as starting
material; Phase 2 still has to build the unified picker; etc.

## Current state

Below is a file-grounded map of where execution-profile inputs live. Every
ref is repo-root relative.

### Provider — six sources of truth across three repos

**Platform TS (`parallel-agent-platform`):**

- `contracts/provider-registry.ts:153` — `CREDENTIAL_PROVIDER_IDS` (11 entries)
- `contracts/provider-registry.ts:166` — `KNOWN_EXECUTION_PROVIDER_IDS` (8 entries)
- `contracts/provider-registry.ts:177` — `MANAGER_PROVIDER_IDS` (2 entries — strict subset)
- `contracts/provider-registry.ts:179` — `MODEL_PROVIDER_IDS` (12 entries — for catalog lookups)
- `apps/api/src/repositories/routing-rules.ts:34` — `ROUTING_RULE_PROVIDER_ALLOWED` (16 entries — pre-DB guard, added after the openai_codex incident)
- `apps/api/src/repositories/credentials.ts` — `CREDENTIAL_KIND_VALUES` (16 entries — discriminator column allowlist)
- `apps/web/src/components/settings/AgentDetail/constants.ts:29` — `RUNTIME_PROVIDER_OPTIONS` (4 entries — what the routing-rule editor dropdown actually shows)

**Database (`harper-server`):**

- `routing_rule_provider_check` (currently 12 entries; PR #518 expands to 16)
- `credential_kind_check` (16 entries — in sync)

**Runtime Elixir (`parallel-agent-runtime`):**

- `apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex:33` — `@supported_providers` (8 entries — matches platform `KNOWN_EXECUTION_PROVIDER_IDS`)
- `apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex:16` — manager-only `@supported_providers` (currently 4 cloud entries: `openai`, `openai_responses`, `openai_compatible`, `local`; **missing `openai_codex`** — a manager agent wired to ChatGPT OAuth would silently idle as `:manager_provider_unsupported`)

Drift today: web dropdown is a 4-entry subset (user literally can't pick
`openai_codex`, `codex`, `openclaw`, `computer_use` in the routing editor).
Manager runtime resolver is a 4-entry subset that also misses
`openai_codex`. `anthropic` is both a credential/model provider and a
supported execution provider for standard runtime profiles, so any
replacement policy must preserve it for the agent types that can execute
with it today.

### Model — parsed from a `provider/model` string in five places

- `contracts/agent-helpers.ts:15` — `deriveProviderFromModel()`
- `contracts/execution-profile.ts:238` — `deriveExecutionProviderFromModel()`
- `apps/api/src/services/execution-profile-resolver.ts:286` — inline split on `/`
- `apps/web/src/components/dashboard/InlineCredentialForm.tsx:70` — client-side split on `/`
- `apps/web/src/lib/agent-model-policy.ts:93` — `modelProviderForSelection()`

If the model string format ever changes (e.g., adding a version segment),
all five sites have to move together. There's no shared parse helper.

### Default model — five places (was six)

- `contracts/model-catalog.ts:92` — `DEFAULT_MODEL_ID = "openai/gpt-5.2"`
- `contracts/model-catalog.ts` — `defaultModelForProvider()` ✅ added in #434, now the canonical server-side lookup (used by `syncCredentialIntoRoutingRuleForAgent` and `syncModelIntoRoutingRuleForAgent`). Reads from `MODEL_CATALOG_FALLBACK`.
- `apps/web/src/stores/onboarding.ts:6` — `DEFAULT_MODEL_BY_PROVIDER` (web-only, openai/anthropic only). Should fold into `defaultModelForProvider` in Phase 1.
- `apps/web/src/components/settings/ManagerAgentSection/utils.ts:32` — `DEFAULT_MODELS`
- `apps/web/src/components/settings/AgentsSection.tsx:22` — `newModel` literal
- `apps/web/src/components/dashboard/InlineCredentialForm.tsx:39` — `providerModel()`
- `apps/web/src/components/OnboardingCards/CloudKeyCard.tsx` — uses `DEFAULT_MODEL_BY_PROVIDER`

Swapping the platform default model still requires editing five files
(was six before #434). Phase 1 collapses the remaining five into one.

### Runner kind — five sources of truth across three repos

**Platform TS — derivation in three places:**

- `apps/api/src/services/stored-agent-routing.ts:23` — `runnerKindForAgent()`
- `apps/api/src/services/agent-runtime-profile.ts:28` — `runnerKindForRuntimeProfile()`
- `apps/web/src/lib/agent-model-policy.ts:19` — `runnerKindForAgent()` (web mirror)

**Platform TS — declarations:**

- `contracts/runner-kinds.ts` — `RUNNER_REGISTRY` / `RUNNER_KINDS` (11 entries, the canonical list)
- `apps/api/src/repositories/routing-rules.ts:20` — `ROUTING_RULE_RUNNER_KIND_ALLOWED` (11 entries, pre-DB guard)

**Database (`harper-server`):**

- `routing_rule_runner_kind_check` (currently 10 entries; PR #518 adds `planner` → 11)

**Runtime Elixir (`parallel-agent-runtime`):**

- `apps/orchestrator/lib/symphony_elixir/schema/execution_profile.ex:32` — `@supported_runner_kinds` (**8 entries**: `codex, claude_code, openclaw, computer_use, manager, planner, local_relay, local_model_coding`). **Missing 4 the platform writes today: `local_runtime`, `llm_tool_runner`, `openclaw_ws`, `openclaw_http_sse`.** Manager agents use `llm_tool_runner` and work in production, so this Ecto validation is either bypassed in the manager path or this list is silent dead code waiting to bite the next path that hits it.

Derivation rules are interdependent: `(agent_type, provider)` determines
`runner_kind`. There is no UI surface showing the user which runner they'll
get; switching provider from `openai` to `local` silently switches runner
from `codex` to `local_model_coding`.

### Credential reference — three resolution paths

- `routing_rule.credential_id` — direct row ID
- `routing_rule.credential_alias` — workspace-scoped alias string
- `credential.key_value.agent_id` — legacy agent-scoped secret in JSONB

These are resolved by `apps/api/src/services/execution-profile-resolver.ts`
across four functions (`resolveCredentialAlias`, `getAgentCredentialId`,
`credentialRefFromRoutingRule`, plus the inline fallback). Manager agents
have a fourth path — they can submit a new API key inline at activation
time, bypassing the credential picker entirely.

### Storage — routing rule + gateway config, dual writes

Stored (coding/planning) agents write to:

- `routing_rule` (agent-scoped, agent_runtime_profile.upsertAgentCredentialReferenceRule)
- `gateway_config` (agent-scoped, legacy fallback path)

Manager agents write to:

- `routing_rule` (agent-scoped)
- `gateway_config` (**workspace-scoped** under `runners.manager`)

If only one write succeeds, the agent ends up in a split state where
`getAgentRuntimeProfile()` and the runtime scheduler disagree on what model
to use. Resolver fallback chain papers over this most of the time, but the
divergence isn't surfaced to the user.

#429 / #434 partially mitigated this for the *write* paths — credential
saves, OAuth saves, and PATCH-agent-model now all funnel through the
same `syncCredentialIntoRoutingRuleForAgent` /
`syncModelIntoRoutingRuleForAgent` helpers, which guarantee the routing
rule reflects the change. The *legacy gateway_config fallback* on read
is still in place; Phase 4 collapses storage so the fallback isn't
needed.

### UI — three model pickers

- `apps/web/src/components/settings/AgentDetail/AgentRuntimeEditor.tsx` — standard agent (free-text model input, no provider dropdown)
- `apps/web/src/components/settings/ManagerAgentSection.tsx:288` — manager (provider dropdown + dependent model dropdown)
- `apps/web/src/components/dashboard/InlineCredentialForm.tsx` — onboarding (provider dropdown + model dropdown)
- `apps/web/src/components/settings/ModelsSection.tsx:182` — workspace model browser (read-only catalog)

Each picker has its own provider→model defaulting logic, its own validation
gaps, and its own API call shape. Adding a new provider means updating all
three.

## Proposed model

### One value type

```ts
// contracts/execution-profile.ts (new canonical shape)
export const ExecutionProfileSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  agentType: AgentTypeSchema, // user-chosen, drives matrix below
  provider: ExecutionProviderSchema, // single enum (today's KNOWN_EXECUTION_PROVIDER_IDS)
  model: z.string().min(1), // fully qualified, e.g. "openai_codex/gpt-5.5"
  runnerKind: RunnerKindSchema, // derived from (agentType, provider); never user-input
  credentialRef: CredentialReferenceSchema.nullable(),
  baseUrl: z.string().url().nullable(), // openai_compatible only
});
```

This is the only input the API takes and the only output the resolver
returns. No more "rule vs profile vs gateway config" divergence.

### One validity matrix

A single table replaces the implicit validation scattered across
`stored-agent-routing.ts`, `agent-runtime-profile.ts`, and the manager
route:

```ts
// contracts/execution-profile-policy.ts (new)
export const EXECUTION_PROFILE_POLICY: ReadonlyArray<{
  agentType: AgentType;
  provider: ExecutionProvider;
  runnerKind: RunnerKind;
  credentialRequired: boolean;
  baseUrlRequired: boolean;
}> = [
  {
    agentType: "coding",
    provider: "openai",
    runnerKind: "codex",
    credentialRequired: true,
    baseUrlRequired: false,
  },
  {
    agentType: "coding",
    provider: "anthropic",
    runnerKind: "codex",
    credentialRequired: true,
    baseUrlRequired: false,
  },
  {
    agentType: "coding",
    provider: "openai_codex",
    runnerKind: "codex",
    credentialRequired: true,
    baseUrlRequired: false,
  },
  {
    agentType: "coding",
    provider: "openai_compatible",
    runnerKind: "codex",
    credentialRequired: false,
    baseUrlRequired: true,
  },
  {
    agentType: "coding",
    provider: "local",
    runnerKind: "local_model_coding",
    credentialRequired: false,
    baseUrlRequired: false,
  },
  {
    agentType: "planning",
    provider: "openai",
    runnerKind: "llm_tool_runner",
    credentialRequired: true,
    baseUrlRequired: false,
  },
  {
    agentType: "planning",
    provider: "anthropic",
    runnerKind: "llm_tool_runner",
    credentialRequired: true,
    baseUrlRequired: false,
  },
  {
    agentType: "planning",
    provider: "local",
    runnerKind: "planner",
    credentialRequired: false,
    baseUrlRequired: false,
  },
  {
    agentType: "manager",
    provider: "openai",
    runnerKind: "llm_tool_runner",
    credentialRequired: true,
    baseUrlRequired: false,
  },
  {
    agentType: "manager",
    provider: "openai_compatible",
    runnerKind: "llm_tool_runner",
    credentialRequired: false,
    baseUrlRequired: true,
  },
  // ... etc
];
```

`runnerKind` is no longer a separate concept the user (or code) chooses —
it's a function of `(agentType, provider)`. `MANAGER_PROVIDER_IDS` and
`KNOWN_EXECUTION_PROVIDER_IDS` collapse into rows of this table.

### One picker

`apps/web/src/components/ExecutionProfilePicker.tsx` (new) replaces all
three of today's pickers. It accepts:

```ts
type Props = {
  agentType: AgentType;
  value: ExecutionProfile;
  onChange: (next: ExecutionProfile) => void;
};
```

Internally it:

- Filters allowed providers by `agentType` using the policy matrix.
- Renders provider dropdown → model dropdown (sourced from catalog) → credential picker.
- Shows the user the derived `runnerKind` as a read-only badge
  ("This agent will run with `codex`") — eliminates the silent-change footgun.
- Disables credential picker for credentialless rows and the baseUrl input
  for non-compatible rows.

`ManagerAgentSection`, `AgentRuntimeEditor`, and `InlineCredentialForm`
delegate to this component. They keep their wrapper UI (cards, layout) but
own none of the policy.

### Transition-aware swaps

Most execution profile changes are within the same family (swapping
`openai/gpt-5.2` → `openai/gpt-5.5`, both still `codex` runner with the
same credential). Some changes cross **execution stacks** — local vs
cloud — and have second-order consequences that the user needs to see
before saving. Classify the swap up front:

| From → To             | Runner change                            | Credential change                       | Worker stack change      | Cost shift              |
|-----------------------|------------------------------------------|-----------------------------------------|--------------------------|-------------------------|
| Cloud → Cloud (same)  | none                                     | maybe (new provider needs new key)      | none                     | none                    |
| Cloud → Cloud (cross) | maybe (e.g. openai → openai_codex)       | yes (new credential)                    | maybe (codex CLI auth)   | varies                  |
| Local → Cloud         | `local_model_coding`/`planner` → `codex`/`llm_tool_runner` | required (new credential needed)        | helper relay → CLI/HTTP  | free → metered          |
| Cloud → Local         | reverse                                  | optional (becomes unused)               | CLI → helper relay       | metered → free          |

For every swap, the picker runs a **pre-flight check** before the user
can save:

- **Credential availability.** If the target row requires a credential
  and none exists for that provider, the picker offers an inline
  "Create credential" sub-flow (delegates to `CredentialEditor` from the
  companion credentials scope) rather than letting the save go through
  and fail at activation.
- **Tool grant compatibility.** Each runner kind has a different tool
  surface (e.g., `local_model_coding` exposes different shell tools than
  `codex`). If the target runner doesn't support a tool that's currently
  granted to the agent, surface the list before save: *"Switching to
  `codex` will drop the `local_shell` tool grant. Continue?"* Don't
  silently strip grants; require the user to acknowledge.
- **Local runtime availability.** Going to `local_model_coding` requires
  the helper to be connected and the chosen model present in the relay.
  Pre-flight ping; show *"Local runtime isn't connected — start it with
  `pnpm run start:local` in the helper repo"* instead of saving and
  failing.
- **In-flight session.** If the agent has an active websocket / running
  worker, the swap is queued and applied at next idle (or after the user
  confirms a forced restart). Surfaces a small "active session will
  reconnect" notice.
- **Cost warning, once.** First time a workspace swaps from a free local
  runner to a metered cloud runner, the picker shows a one-time
  confirmation: *"This change will route agent traffic through OpenAI.
  Charges accrue per token."* Subsequent swaps within the same workspace
  don't re-prompt (acknowledged once per workspace, stored in
  `workspace_setting`).
- **Capability changes.** If the new model lacks a capability the agent
  is configured to use (e.g., the chat is set to send images but the
  new model is text-only), warn before save. Capability columns live on
  the model catalog row; the picker reads them.

The pre-flight is a single function returning a discriminated union of
`ready | needs_credential | tool_grant_conflicts | runtime_not_connected
 | capability_loss | first_cloud_switch`. The picker renders the right
remediation UI per case. Save is gated on `ready` (or
`forced_after_confirmation`).

### Activation aftermath

After a successful swap, the picker:

1. Fires the unified `PUT /api/agents/:agentId/execution-profile` (see below).
2. Server-side: in one transaction, updates the routing rule, adjusts
   tool grants (drop incompatible, no auto-add), and bumps a
   `routing_rev` counter on the agent.
3. Runtime: subscribes to `routing_rev`; existing workers gracefully
   drain. New requests use the new profile.
4. UI: shows a "Routing updated — `local_model_coding` → `codex`" toast
   with an Undo affordance (Undo reverts to the previous profile within
   60s; after that, undo just becomes a normal swap).

This makes the local → cloud transition (and back) safe, observable,
and reversible. Today it's none of those — the rule changes silently,
incompatible tool grants stay, the local runtime might be running
unaware, and an active worker might still process queued messages with
the old profile.

**Status (post-#434):** the "rule changes silently" half of this is now
addressed for the three write paths we've encountered (credential save,
OAuth save, PATCH-agent-model). The other pieces — tool-grant
compatibility check, runtime ping, in-flight session handling, cost
warning, capability loss, the `routing_rev` graceful drain, and the
60-second Undo — are still proposed for the unified
`PUT /api/agents/:agentId/execution-profile` endpoint in Phase 3.

### One write

```ts
// apps/api/src/routes/execution-profile.ts (new, replaces three routes)
PUT /api/agents/:agentId/execution-profile
```

Body is the `ExecutionProfile` value above. Handler:

1. Validates against the policy matrix (rejects invalid combinations at the
   schema layer, not at runtime).
2. Writes a single `routing_rule` row.
3. For manager agents, also updates `gateway_config.runners.manager` —
   **inside the same transaction**, so the split-state risk goes away.

Replaces:

- `PUT /api/stored-agents/:id/credential-reference`
- `PUT /api/agents/:agentId/runtime-profile`
- `POST /api/manager-agent/activate` (the credential portion; activation
  becomes a separate concern)

### One default

```ts
// contracts/model-catalog.ts (canonicalized)
export const DEFAULT_EXECUTION_PROFILE_BY_AGENT_TYPE: Record<
  AgentType,
  Pick<ExecutionProfile, "provider" | "model">
> = {
  coding: { provider: "openai", model: "openai/gpt-5.2" },
  planning: { provider: "openai", model: "openai/gpt-5.2" },
  manager: { provider: "openai", model: "openai/gpt-5.2" },
  custom: { provider: "openai", model: "openai/gpt-5.2" },
};
```

All six existing default sites import from here. Changing the platform
default model becomes a one-line edit.

## Phased migration

Each phase is independently shippable, doesn't break existing agents, and
the codebase stays green at every step.

### Phase 1 — Consolidate enums and defaults (1 platform PR)

Repo: `parallel-agent-platform`.

Partially done in #434:
- ✅ `defaultModelForProvider()` and `modelMatchesProvider()` added to
  `contracts/model-catalog.ts`. Server-side defaults now have one source
  of truth.

Still to do:
- Add `EXECUTION_PROFILE_POLICY` table to `contracts/execution-profile-policy.ts`.
- Add `DEFAULT_EXECUTION_PROFILE_BY_AGENT_TYPE` to `contracts/model-catalog.ts`.
- Replace the remaining five hardcoded default sites (web-side
  `DEFAULT_MODEL_BY_PROVIDER`, `DEFAULT_MODELS`, the literal in
  `AgentsSection`, `providerModel()` in `InlineCredentialForm`,
  `CloudKeyCard` consumer) with imports from the new constants.
- Delete `MANAGER_PROVIDER_IDS` — manager-allowed providers come from the
  policy table rows where `agentType === "manager"`.
- Delete duplicate `deriveProviderFromModel()` copies; consolidate on the
  contracts/ helper.

No DB changes. No API contract changes. UI behavior unchanged.

### Phase 2 — One picker component (1 platform PR)

Repo: `parallel-agent-platform`.

- Build `ExecutionProfilePicker.tsx`.
- Replace `ManagerAgentSection`'s inline picker with it.
- Replace `AgentRuntimeEditor`'s model input with it.
- Replace `InlineCredentialForm`'s provider+model section with it.
- Keep existing API endpoints intact — picker outputs the same fields the
  current routes accept.

No backend changes. Shipping risk is mostly UI regression.

### Phase 3 — Unified endpoint (1 platform PR)

Repo: `parallel-agent-platform`.

- Add `PUT /api/agents/:agentId/execution-profile` accepting the full value.
- Internal handler owns the routing-rule/gateway-config writes inside one
  transaction while storage remains split.
- Update every web caller to use the new endpoint.
- Delete the three replaced route handlers and their tests in this PR. Do not
  keep deprecated compatibility routes.

DB unchanged. API route compatibility is intentionally not preserved; this is
an internal platform boundary, so callers move with the route replacement.

### Phase 4 — Collapse storage (1 platform PR + 1 harper-server migration PR)

Repos: `parallel-agent-platform`, `harper-server`.

- Add a single source of truth: extend `routing_rule` to be the only
  storage. Manager scheduler reads from `routing_rule` joined with
  `gateway_config` for manager-specific fields (cadenceMs, dueTaskQuery)
  which move to a new `manager_runtime_config` table.
- Drop the `gateway_config.runners.manager` and `gateway_config.runners[]`
  paths. Resolver no longer falls back to gateway_config.

Requires harper-server migration. This phase is the heaviest and may need
its own scoping doc.

### Phase 5 — Delete platform gateway config fallback (1 platform PR)

Repo: `parallel-agent-platform`.

- Delete the legacy gateway_config fallback path in the resolver once the
  storage migration has shipped and the runtime no longer reads execution
  profile state from gateway_config.

### Phase 6 — Delete runtime gateway config fallback (1 runtime PR)

Repo: `parallel-agent-runtime`.

- Update the Elixir orchestrator/launcher execution-profile resolution so
  runtime readers use the relational routing-rule source of truth after Phase
  4 lands.
- Delete the gateway_config execution-profile fallback for model/provider/
  credential/runner selection.
- Keep manager-specific runtime knobs such as cadence and due-task query on
  their dedicated config surface; this phase only removes execution-profile
  fallback reads.
- Add or update runtime tests that currently assert `fallback_used` or
  gateway_config-derived execution profiles.

This requires a separate runtime scoping doc and PR because the runtime repo
owns the Elixir readers and launcher/orchestrator tests.

### Phase 7 — Cross-repo enum drift CI check (1 platform PR)

Repo: `parallel-agent-platform`.

After the structural consolidation lands, the six sources of truth identified
in "Current state" collapse to four (platform contracts, harper-server SQL
constraints, runtime Elixir validation, web dropdown). They can't be reduced
further without exposing the migration text to the platform repo. To keep
them aligned without future drift, add a CI check that:

- Reads `harper-server`'s latest routing-rule and credential CHECK constraints
  (via the schema diagnostic endpoint or fetched migration text).
- Reads `parallel-agent-runtime`'s `@supported_providers`,
  `@supported_runner_kinds`, and `SessionResolver.@supported_providers`.
- Asserts each is a superset of the platform's `KNOWN_EXECUTION_PROVIDER_IDS`
  / `RUNNER_KINDS` (or, for the manager resolver, a documented superset of
  `MANAGER_PROVIDER_IDS`).
- Fails CI on mismatch with a message telling the developer which list to
  update, in which repo.

This is the long-term answer to the credential.kind / openai_codex / planner
drift incidents — a CI gate ensures the drift can't happen again, instead of
relying on every developer remembering to update all four places.

## Open questions

- **Tool grant alignment across runner kinds.** Different runners support
  different tool surfaces (e.g., `local_model_coding` has direct shell
  access via the helper relay; `codex` runs via the codex CLI with its
  own tool model). The transition-aware swap section above says we drop
  incompatible grants and require the user to acknowledge — but the
  authoritative compatibility matrix between runner_kind and tool isn't
  encoded today. We'll need to build it (or push that requirement to
  `agent-tool-grant-data-model-scope.md`).

- **Cost warning persistence model.** The "first cloud switch" warning is
  stored as `workspace_setting.acknowledged_cloud_routing` (or similar).
  Need a small harper-server migration. Worth bundling with the other
  phase-2 migrations.

- **Custom agents.** Today `agent_type = "custom"` opts out of the model
  picker entirely (the agent has a `customTarget.backendType`). The policy
  matrix should either explicitly include a "custom" row that sidesteps
  provider/model, or `ExecutionProfilePicker` should refuse to render for
  custom agents. Either is fine; need to pick one.

- **openai_codex provider routing.** The ChatGPT OAuth flow this scoping
  doc was written alongside (PR #434) stores credentials with
  `provider = "openai_codex"`. The codex worker today only consumes
  `OPENAI_API_KEY` env. Whether `openai_codex` should be a separate row
  in the policy matrix (with its own runner like
  `codex_oauth`) or share `runner_kind = "codex"` with a provider-side
  branch in the launcher depends on how PR #315 evolves. Hold this open
  until that question lands.

- **Multi-credential agents.** Today an agent has one routing rule with
  one credential ref. There's a latent ask for "different credentials per
  task type" (e.g., a coding agent that uses Anthropic for review but
  OpenAI for codegen). The unified value above doesn't allow that. If
  multi-credential is on the roadmap, the schema should be a list of
  profiles keyed by intent. If not, leave it as-is.

- **Sunset legacy `agent.model_settings.primary`.** That column is read
  by `extractPrimaryModel()` as a fallback. Phase 4 should delete it, but
  there may be older agents that have only that field set. Need a one-off
  migration to backfill `routing_rule` rows for those.

## Out of scope

- Tool grant model. That's a separate refactor — see
  `docs/active/agent-tool-grant-data-model-scope.md`.
- Credential storage layer (secret manager vs JSONB). Today's storage is
  fine; this doc only consolidates the _selection_ and _resolution_ paths.
- Runtime-side implementation details beyond the Phase 6 fallback removal
  scope. The platform doc tracks sequencing; the runtime PR owns Elixir file
  lists, tests, and verification.

## Success criteria

- Adding a new provider (e.g., a hypothetical `mistral_codex`) requires
  editing exactly:
  1. One row in `EXECUTION_PROFILE_POLICY`.
  2. One entry in the model catalog.
  3. (If credentials needed) one row in `PROVIDER_REGISTRY`.
- Changing the platform default model requires editing exactly one line.
- The UI shows the user what `runner_kind` they're getting before they
  save — no more silent runner switches when changing provider.
- A local → cloud (or cloud → local) swap surfaces every relevant
  consequence to the user *before* save: new credential required,
  tool grants that won't survive, helper relay connectivity, cost
  warning the first time. No swap silently strips a tool grant or
  routes a paid request the user didn't expect.
- Active worker sessions reconnect cleanly on profile change; the user
  has a 60-second Undo to revert without leaving stale state behind.
- There is no code path where `routing_rule` and `gateway_config` can
  diverge for the same agent.
