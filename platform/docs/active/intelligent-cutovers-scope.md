# Intelligent Cutovers — Scope

## Goal

When the model an agent is currently using becomes unavailable (rate-limited,
overloaded, refusing on content policy, timed out, stream interrupted), the
agent should automatically continue against a designated alternative — not
fail the task. And when the agent declares "I require a frontier-tier model
to do my work adequately," the cutover logic must refuse to silently degrade
it to a small model just to keep going.

The product needs both halves. Without **fallback chains** a rate limit on
the primary model kills the task. Without an **adequacy floor** the system
quietly serves a worse model than the agent was designed for and the user
gets bad output without knowing why.

Specifically:

1. **A primary-with-fallbacks model selection** per agent — ordered chain of
   `{provider, model, credential}` tuples. The orchestrator walks the chain
   on each cutover-eligible error until one link succeeds or the chain is
   exhausted.
2. **A model-tier registry** — canonical classification of which models are
   frontier-tier, mid-tier, or local-tier, in one source of truth that
   platform, runtime, and helper all agree on.
3. **An adequacy floor** per agent — a declared minimum tier. The cutover
   walker skips any link below the floor; if no link in the chain meets the
   floor, the task escalates to a human instead of degrading.
4. **A trigger contract** — explicit list of error codes that trigger
   cutover (today's `retryable_provider_codes` plus content-policy
   refusal); explicit list of errors that fail-fast or escalate instead.
5. **An audit trail** — every cutover decision is recorded with the
   triggering error, the model chosen as fallback, and the outcome.
   Without this the user cannot see when their plan ran on a fallback.
6. **Carry-over semantics** for message history — the conversation state
   persists across cutover; the new model is given the same instructions
   and tools, with provider-specific format reconstruction handled in the
   runner.

## Current state

This section is grounded in a code audit. Each ref is absolute.

### What exists: error classification

The runtime already classifies provider errors into a small set of codes
suitable for driving cutover decisions.

- `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/runner/observability.ex:15-30`
  defines `@retryable_provider_codes`: `provider_rate_limited`,
  `provider_timeout`, `provider_overloaded`, `provider_stream_interrupted`,
  `provider_unknown`.
- Same file, `:225-245` — `provider_status_error_code(status, body)` maps
  HTTP status to a code: `429 → provider_rate_limited`,
  `500/502/503/504 → provider_overloaded`, `408 → provider_timeout`,
  `401/403 → provider_auth_failed`, `400/422 → provider_invalid_request`.
- `:108-136` — `provider_status_failure()` returns a struct with
  `retryable: true/false` flag.
- `:167-171` — `Observability.log_provider_failure()` emits a structured
  runtime log event with `error_code`, `retryable`, `status_code`, `attempt`,
  `retry_count`, `provider`, `model`, `runner_kind`.

This is **enough signal to drive cutover**. The gap is acting on it.

### What's missing: cutover action

Errors are *marked* retryable but **not retried** by the runtime. They
propagate up to the caller as `{:error, {:retryable, reason}}` and the task
fails.

- `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/runner/openclaw.ex:84-100`
  — catches HTTP error, classifies, returns `{:error, ...}`. No retry, no
  fallback.
- `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/runner/llm_tool_runner.ex:126`
  — `model_client_create_response(session, request, attempt)` returns the
  error to `run_model_loop` which fails the turn. The `attempt` counter
  exists but there is no second attempt code path.
- `parallel-agent-runtime/apps/orchestrator/lib/symphony_elixir/runner/codex.ex`
  — delegates to `AppServer.*` via JSON-RPC; error surface opaque at the
  runner level.

There is no module in the runtime that owns "what to do when a provider
fails." The runner stops; the caller decides whether to requeue (and
today the platform dispatcher does not).

### What's missing: fallback chain on the execution profile

The execution profile is single-model.

- `parallel-agent-platform/contracts/execution-profile.ts:204-217`:
  ```typescript
  ExecutionProfileSchema = z.object({
    agentId, workspaceId, role, runnerKind,
    provider,               // single
    model,                  // single
    credentialRef,          // single
    toolProfile, ...
  });
  ```
- `parallel-agent-platform/contracts/execution-profile.ts:34-37`:
  ```typescript
  CredentialReferenceSchema = z.object({
    type: z.enum(["credential_id", "alias"]),
    value: z.string(),
  });
  ```
  Single credential, no list.

No `alternatives`, `fallback_models`, or `model_tier_requirement` field
anywhere on the profile.

### What's missing: routing rule fallback

Routing rules resolve to a single execution profile. There is no
`fallback_rule_id`, no ordered list of alternatives. (Specific table
shape under
`parallel-agent-platform/apps/api/src/repositories/routing-rules.ts`;
the columns are single-target.)

### What's missing: model tier / adequacy concept

Searched across all three repos for `tier`, `frontier`, `minimum_model`,
`adequacy`, `preferred_models`. The only hits:

- `tier` in OQ-05 means *workspace billing tier*, not model tier.
- `preferred_models` in `agent-runner-defaults.ts` is a UI sorting hint, not
  an execution constraint.
- The vision doc references "frontier" aspirationally, not in any code path.

No model-tier registry, no per-agent adequacy declaration.

### What's missing: content-policy refusal classification

`observability.ex` maps HTTP errors but content-policy refusals (Anthropic
`refusal` blocks, OpenAI `finish_reason="content_filter"`) are not in the
error-code surface today. These should be cutover triggers — a user-flagged
scenario was "the agent refuses to do work, fall back to a model that
won't" — but the runtime doesn't classify them as retryable provider
codes.

### What's missing: multi-credential per provider

If a workspace has two OpenAI keys and key A rate-limits, today there is
no second key to fall back to.

- `parallel-agent-platform/docs/reference/oq-04-credentials-pr-plan.md:26-36`
  acknowledges the database is "substantially under-built" vs the OQ-04
  design.
- `credential_alias` table is scoped (OQ-04) but unbuilt; aliases map name
  → credential UUID, not name → ordered list of credentials.

This intersects with cutovers: same-provider key rotation is the cheapest
cutover (no model change, just a different credential). It should be a
first link in any chain.

### What's missing: audit of cutover decisions

Structured logs of provider failures exist in `RuntimeLog`. There is no
table that records *cutover decisions* — "agent X tried model A, hit a
429, fell back to model B, succeeded." Without this:

- The user cannot see which plan tasks ran on a fallback vs the primary.
- We cannot ask "did the cutover work?" without parsing logs.
- We cannot price-or-quota cutovers separately from primary runs.

## Proposed model

### Components

```
                    ┌──────────────────────────────────┐
                    │       Model-tier registry        │
                    │  contracts/model-tiers.ts        │
                    │   (provider, model) → tier       │
                    └──────────┬───────────────────────┘
                               │ referenced by
            ┌──────────────────┴───────────────────┐
            │                                      │
            ▼                                      ▼
┌────────────────────────┐         ┌──────────────────────────┐
│   Execution profile    │         │    Cutover engine        │
│   .primary             │         │  (runtime, new module)   │
│   .fallbacks: []       │         │  • catches provider err  │
│   .model_tier_floor    │         │  • picks next link       │
└────────────────────────┘         │  • enforces floor        │
                                   │  • writes audit row      │
                                   │  • escalates if exhausted│
                                   └──────────────────────────┘
                                              │
                                              ▼
                                   ┌──────────────────────────┐
                                   │  provider_cutover table  │
                                   │  (one row per decision)  │
                                   └──────────────────────────┘
```

### Model-tier registry (canonical)

`contracts/model-tiers.ts` — new file, parallel structure to
`contracts/runner-kinds.ts`. Single source of truth, mirrored into
the harper-server check constraints by the same enum drift check.

The registry's `provider` field is the **broader set of known providers**
from `contracts/provider-registry.ts` (`PROVIDER_REGISTRY` keys), not
only the currently-executable ones. This lets us classify Gemini, xAI,
Mistral, etc. as forward-looking entries even though their execution
adapters do not yet exist. Cutover-engine attempts against a registered-
but-not-executable provider/model fail at dispatch with a clear error
pointing at
[`provider-execution-adapter-rollout-scope.md`](./provider-execution-adapter-rollout-scope.md).

```typescript
export const MODEL_TIERS = ["frontier", "mid", "local", "any"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

type RegisteredProvider = keyof typeof PROVIDER_REGISTRY;

// (provider, model) → tier classification. "any" is not used in the
// registry — it's reserved for the floor value "no floor enforced."
export const MODEL_TIER_REGISTRY: ReadonlyArray<{
  provider: RegisteredProvider;
  model: string;
  tier: Exclude<ModelTier, "any">;
}> = [
  // ─── Anthropic (executable) ───────────────────────────────────────
  { provider: "anthropic", model: "claude-opus-4-7",   tier: "frontier" },
  { provider: "anthropic", model: "claude-sonnet-4-6", tier: "frontier" },
  { provider: "anthropic", model: "claude-haiku-4-5",  tier: "mid" },

  // ─── OpenAI (executable) ──────────────────────────────────────────
  { provider: "openai", model: "gpt-4.1",      tier: "frontier" },
  { provider: "openai", model: "gpt-4.1-mini", tier: "mid" },
  { provider: "openai", model: "gpt-4o",       tier: "frontier" },
  { provider: "openai", model: "gpt-4o-mini",  tier: "mid" },
  { provider: "openai", model: "o3",           tier: "frontier" },
  { provider: "openai", model: "o3-mini",      tier: "mid" },
  { provider: "openai", model: "o1",           tier: "frontier" },

  // ─── openai_codex (ChatGPT OAuth, executable) ─────────────────────
  // Codex maps to OpenAI models via the user's ChatGPT subscription.
  // Tier inherits from the underlying OpenAI model.
  { provider: "openai_codex", model: "gpt-4o",  tier: "frontier" },
  { provider: "openai_codex", model: "gpt-4.1", tier: "frontier" },
  { provider: "openai_codex", model: "o3",      tier: "frontier" },

  // ─── openai_compatible (local via helper, executable) ─────────────
  // Local models served by the helper default to "local" tier. A
  // helper running a flagship-class local model (e.g. Llama 3.1 405B
  // on a workstation) can override with an explicit entry below.
  { provider: "openai_compatible", model: "*", tier: "local" },
  // Optional explicit overrides for known capable local models:
  { provider: "openai_compatible", model: "llama-3.1-405b-instruct", tier: "mid" },
  { provider: "openai_compatible", model: "qwen2.5-coder-32b",       tier: "mid" },

  // ─── Google / Gemini (credentials yes, execution PENDING) ─────────
  { provider: "google", model: "gemini-2.5-pro",   tier: "frontier" },
  { provider: "google", model: "gemini-2.5-flash", tier: "mid" },
  { provider: "google", model: "gemini-2.0-flash", tier: "mid" },

  // ─── xAI / Grok (credentials yes, execution PENDING) ──────────────
  { provider: "xai", model: "grok-4",      tier: "frontier" },
  { provider: "xai", model: "grok-3",      tier: "frontier" },
  { provider: "xai", model: "grok-3-mini", tier: "mid" },

  // ─── Mistral (credentials yes, execution PENDING) ─────────────────
  { provider: "mistral", model: "mistral-large-2", tier: "frontier" },
  { provider: "mistral", model: "mistral-medium",  tier: "mid" },
  { provider: "mistral", model: "codestral",       tier: "mid" },

  // ─── Groq (credentials yes, execution PENDING) ────────────────────
  // Groq hosts open-source models on dedicated inference hardware.
  // Tier follows the underlying model's general capability.
  { provider: "groq", model: "llama-3.3-70b-versatile", tier: "mid" },
  { provider: "groq", model: "llama-3.1-70b",           tier: "mid" },
  { provider: "groq", model: "mixtral-8x7b",            tier: "mid" },

  // ─── OpenRouter (credentials yes, execution PENDING) ──────────────
  // OpenRouter proxies to many models; tier follows the underlying
  // model. Model names use OpenRouter's `<provider>/<model>` form.
  { provider: "openrouter", model: "anthropic/claude-opus-4-7",   tier: "frontier" },
  { provider: "openrouter", model: "anthropic/claude-sonnet-4-6", tier: "frontier" },
  { provider: "openrouter", model: "openai/gpt-4o",               tier: "frontier" },
  { provider: "openrouter", model: "google/gemini-2.5-pro",       tier: "frontier" },
  { provider: "openrouter", model: "meta-llama/llama-3.1-405b",   tier: "frontier" },

  // ─── Together (credentials yes, execution PENDING) ────────────────
  // Together hosts open-source models.
  { provider: "together", model: "meta-llama/Llama-3.1-405B-Instruct", tier: "frontier" },
  { provider: "together", model: "meta-llama/Llama-3.3-70B-Instruct",  tier: "mid" },
  { provider: "together", model: "mistralai/Mixtral-8x22B-Instruct",   tier: "mid" },

  // ─── Perplexity (credentials yes, execution PENDING) ──────────────
  { provider: "perplexity", model: "sonar-pro",                       tier: "mid" },
  { provider: "perplexity", model: "sonar",                           tier: "mid" },
  { provider: "perplexity", model: "llama-3.1-sonar-large-128k-online", tier: "mid" },

  // ─── Azure OpenAI (credentials yes, execution PENDING) ────────────
  // Azure mirrors OpenAI's model lineup; tier inherits from OpenAI.
  // Deployment names vary by subscription; the registry lists the
  // canonical OpenAI names.
  { provider: "azure", model: "gpt-4o",      tier: "frontier" },
  { provider: "azure", model: "gpt-4o-mini", tier: "mid" },
  { provider: "azure", model: "o3",          tier: "frontier" },

  // ─── Bedrock (credentials yes, execution PENDING) ─────────────────
  // AWS Bedrock model IDs follow `<vendor>.<model>-v<n>:<m>` format.
  { provider: "bedrock", model: "anthropic.claude-opus-4-7-v1:0",       tier: "frontier" },
  { provider: "bedrock", model: "anthropic.claude-sonnet-4-6-v1:0",     tier: "frontier" },
  { provider: "bedrock", model: "meta.llama3-1-405b-instruct-v1:0",     tier: "frontier" },
  { provider: "bedrock", model: "mistral.mistral-large-2407-v1:0",      tier: "frontier" },
  { provider: "bedrock", model: "amazon.nova-pro-v1:0",                 tier: "mid" },
];

export function modelTier(
  provider: RegisteredProvider,
  model: string
): Exclude<ModelTier, "any"> | null { ... }
```

#### Coverage caveats

- **Forward-looking entries**: Gemini, xAI, Mistral, Groq, OpenRouter,
  Together, Perplexity, Azure, and Bedrock entries are present so
  routing rules can reference them and the registry has a "pathway"
  for every credential-storage provider in the codebase. The runtime
  cannot actually dispatch to them until their execution adapters land
  — see
  [`provider-execution-adapter-rollout-scope.md`](./provider-execution-adapter-rollout-scope.md).
- **Lookup semantics**: a `null` return from `modelTier()` means the
  model is unknown to the registry. Treat as the lowest tier (`local`)
  for floor enforcement — fail closed, never let an unclassified model
  pass a `frontier` floor.
- **Wildcard semantics**: `{ provider: "openai_compatible", model: "*",
  tier: "local" }` is the only wildcard entry. Other providers must
  list models explicitly so the registry is exhaustive enough to
  reason about.
- **The `"any"` tier value is only valid as a floor setting**; the
  registry never assigns it.
- **Maintenance cadence**: the registry must be updated when a new
  flagship model ships. Treat it as a fast-follow on provider
  announcements — usually a one-line PR. The cross-repo enum drift
  check flags missing entries when a routing rule references an
  unknown model.

#### Cutover dispatch against not-yet-executable providers

When the cutover engine encounters a chain link whose provider is in
the registry but lacks an execution adapter (Gemini, xAI, Mistral,
etc., until the adapter rollout ships), the engine treats it the same
way it treats a below-floor link: **skip and walk on, with the skip
recorded in the audit row**. The link is not a primary failure; it's a
configuration gap.

- Walk-time check: before invoking a link, ask
  `ExecutionAdapters.available?(provider)`. If false, skip and continue.
- Per-skip detail goes into the `RuntimeLog` events for the walk
  (`reason: "no_execution_adapter"`).
- If the chain exhausts entirely (no link had an adapter and met the
  floor), the audit row's `outcome` is `escalated_exhausted` and the
  attention queue entry's reason clarifies whether the cause was
  no-adapters, floor-exhausted, or both.

This makes the gap visible without breaking the immediate task: users
who try to fall back to Gemini before the adapter ships see the
skip in the audit trail and a pointer to
[`provider-execution-adapter-rollout-scope.md`](./provider-execution-adapter-rollout-scope.md),
not a hard error mid-plan.

### Execution profile extension

`contracts/execution-profile.ts` gets two new fields. The existing flat
`provider`/`model`/`credentialRef` continue to mean **the primary** — no
backwards-compat shim needed because we're a new project (per the
no-backcompat rule in CLAUDE.md).

```typescript
ExecutionProfileSchema = z.object({
  agentId, workspaceId, role, runnerKind,
  provider, model, credentialRef,        // primary (existing)
  fallbacks: z.array(z.object({
    provider: ExecutionProviderSchema,
    model: z.string().trim().min(1),
    credentialRef: CredentialReferenceSchema.optional(),
  })).default([]),
  modelTierFloor: ModelTierSchema.default("any"),
  toolProfile, workspacePolicy?, ...
});
```

- `fallbacks` is ordered. The cutover engine walks them in order.
- Each fallback link is the same shape as primary — same providers, same
  credential alias system (OQ-04).
- `modelTierFloor: "any"` (default) means no floor — every link is
  eligible.
- `modelTierFloor: "frontier"` means cutover skips any link whose tier
  is below frontier.

### Routing rule extension

`routing_rule` table gets **one new column** (the adequacy floor) and
a **new join table** (`routing_rule_fallback`) for the ordered chain.
The join-table approach (rather than an inline jsonb array) gives the
fallbacks real foreign keys to `credential`, reuses the existing
`routing_rule.provider` CHECK, and lets the runtime walk the chain
via a typed ordered query.

```sql
-- New column on the existing table for the adequacy floor.
ALTER TABLE routing_rule
  ADD COLUMN model_tier_floor text NOT NULL DEFAULT 'any';

ALTER TABLE routing_rule
  ADD CONSTRAINT routing_rule_tier_floor_check
    CHECK (model_tier_floor IN ('frontier', 'mid', 'local', 'any'));

-- New join table for the ordered fallback chain.
CREATE TABLE routing_rule_fallback (
  routing_rule_id uuid NOT NULL REFERENCES routing_rule(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  provider text NOT NULL,  -- subject to same CHECK as routing_rule.provider
  model text NOT NULL,
  credential_id uuid REFERENCES credential(id) ON DELETE RESTRICT,
  credential_alias text CHECK (
    credential_alias IS NULL
    OR (credential_alias ~ '^[a-z0-9-]+$' AND length(credential_alias) <= 64)
  ),
  PRIMARY KEY (routing_rule_id, position),
  CONSTRAINT routing_rule_fallback_single_credential
    CHECK (num_nonnulls(credential_id, credential_alias) <= 1)
);

CREATE INDEX routing_rule_fallback_rule
  ON routing_rule_fallback (routing_rule_id);
```

The platform routing-rule resolver
(`apps/api/src/repositories/routing-rules.ts`) reads
`model_tier_floor` from the routing rule row and joins
`routing_rule_fallback` ordered by `position` to emit the
`ExecutionProfile.fallbacks` array.

The harper-server migrations scope at
[`vision-gaps-migrations-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/vision-gaps-migrations-scope.md)
M6 also drops the unused `routing_rule.next_fallback_rule_id`
linked-list column (replaced by the join table).

### Cutover trigger codes

Add to `observability.ex` `@retryable_provider_codes`:

- `provider_content_refused` — for Anthropic refusal blocks, OpenAI
  `finish_reason="content_filter"`, content-policy 4xx responses.

Final cutover-eligible set:

| Code | Trigger |
|---|---|
| `provider_rate_limited` | HTTP 429 |
| `provider_overloaded` | HTTP 500/502/503/504 |
| `provider_timeout` | HTTP 408, client-side timeout |
| `provider_stream_interrupted` | mid-stream disconnect |
| `provider_unknown` | unclassified network/transport |
| `provider_content_refused` | content-policy refusal (new) |

**Not cutover-eligible** (these escalate or fail-fast, see runtime scope):

| Code | Why not |
|---|---|
| `provider_auth_failed` (401/403) | Credential is broken — fix credential, don't fallback |
| `provider_invalid_request` (400/422) | Request is malformed — bug in our code, fail-fast |

### Adequacy floor enforcement

When the cutover engine walks the fallback chain:

1. For each link, look up its tier from `MODEL_TIER_REGISTRY`.
2. If the link's tier is lower than `modelTierFloor`, skip it.
3. If the chain exhausts without a link meeting the floor, escalate.

The tier ordering for "lower than" is:
`frontier > mid > local`. A `local` model does not satisfy a `frontier`
floor. A `frontier` model satisfies any floor including `mid` and `local`.

Floor `any` accepts everything.

### Audit table

New table in harper-server:

```sql
CREATE TABLE provider_cutover (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id),
  agent_id uuid NOT NULL REFERENCES agent(id),
  work_item_id uuid REFERENCES work_items(id),
  triggered_at timestamptz NOT NULL DEFAULT now(),

  from_provider text NOT NULL,
  from_model text NOT NULL,
  from_credential_id uuid REFERENCES credential(id),

  to_provider text,
  to_model text,
  to_credential_id uuid REFERENCES credential(id),

  trigger_error_code text NOT NULL,
  trigger_status_code int,
  elapsed_ms int NOT NULL,

  outcome text NOT NULL
    CHECK (outcome IN ('fallback_succeeded', 'fallback_failed',
                       'escalated_floor', 'escalated_exhausted'))
);

CREATE INDEX provider_cutover_workspace_recent
  ON provider_cutover (workspace_id, triggered_at DESC);
CREATE INDEX provider_cutover_work_item
  ON provider_cutover (work_item_id);
```

Outcomes:

- `fallback_succeeded` — the next link in the chain handled the turn.
- `fallback_failed` — the next link also errored; engine continues walking.
- `escalated_floor` — no remaining link meets the adequacy floor;
  escalate to human (links to Pillar 4.5 attention queue).
- `escalated_exhausted` — chain walked through entirely, no link
  succeeded; escalate to human.

Surfaced in the platform API via:

- `POST /api/work-items/:id/cutovers` — runtime-owned audit writes land
  through the platform API rather than direct PostgREST calls.
- `GET /api/work-items/:id/cutovers` — for the plan dashboard to show
  "ran on fallback" badges.

### Cutover engine — behavior contract

Implemented in the runtime (see
[intelligent-cutovers-runtime-scope](../docs/intelligent-cutovers-runtime-scope.md)
in the runtime repo). Contract:

1. Provider call fails with a cutover-eligible error code.
2. Engine examines execution profile's `fallbacks` list.
3. Walk the list in order. For each candidate:
   - Skip if its registry-tier is below `modelTierFloor`.
   - Attempt the call against the candidate.
   - On success: record `fallback_succeeded` row, return result to caller.
   - On failure with another cutover-eligible code: record `fallback_failed`
     row, continue walking.
   - On failure with a non-eligible code: stop walking, escalate.
4. If the walk exhausts:
   - If at least one link was skipped because of the floor, record
     `escalated_floor`.
   - Otherwise record `escalated_exhausted`.
   - Push an entry to the attention queue with reason `cutover_exhausted`.

### Carry-over semantics

Cutover preserves conversation state. The
[model-agnostic-message-store](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/shipped/model-agnostic-message-store-plan.md)
foundation makes this work:

- Message history is provider-agnostic — each message records the model
  that generated it; reading the history into a different model is
  already supported.
- System prompt is the same across providers (regenerated against the
  new provider's prompt format in the runner).
- Tool definitions translate via the universal tool-calling contract
  (see [universal-tool-calling-plan](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/universal-tool-calling-plan.md)).
- In-flight assistant turn at the point of cutover: discard the partial
  output, re-run the turn from the last user message against the new
  model.

### Helper-side participation

Local-model failures need the same classification:

- When a helper-side runner (e.g. `openai_compatible` against local Ollama)
  hits a timeout or local 5xx, the helper should surface the error with
  the same `provider_*` code shape so the runtime cutover engine treats
  it identically to a cloud failure.
- The helper does not itself walk the fallback chain — it reports the
  failure; the runtime cutover engine decides the next step (which may
  route to a cloud model rather than back to the helper).

Helper-side scope changes are small enough to be a section in the
runtime scope doc rather than a third file.

## DB migrations

Harper-server changes for this scope are enumerated in
[`harper-server/docs/vision-gaps-migrations-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/vision-gaps-migrations-scope.md)
(M5, M6, M7).

## PR-level decomposition

This scope's 6 phases are broken into 12 reviewable PRs in
[`intelligent-cutovers-pr-plan.md`](./intelligent-cutovers-pr-plan.md).
Each PR has concrete file paths, dependencies, and acceptance criteria.
That doc is the right starting point when actually opening PRs.

## Phased migration

The shape is six steps. Each is independently mergeable; routing-rule
extension blocks runtime cutover (the engine needs somewhere to read the
chain from), but registry, audit table, and contract changes can land
ahead of either.

### Phase 1 — Model-tier registry

- Add `contracts/model-tiers.ts` with `MODEL_TIERS`, `MODEL_TIER_REGISTRY`,
  and `modelTier()` helper.
- Add cross-repo enum drift check (`scripts/check-cross-repo-enums.mjs`)
  so the registry stays in sync with any DB constraints that reference it.
- Add a runtime mirror at
  `apps/orchestrator/lib/symphony_elixir/model_tiers.ex` regenerated
  from the contracts file via `pnpm run supabase:schema:sync` (extend
  the existing schema-sync script).

No DB change. No behavior change. Purely a registry.

### Phase 2 — Content-refusal error code

- Extend `observability.ex` `@retryable_provider_codes` with
  `provider_content_refused`.
- Add detection logic in each runner's response parser: Anthropic
  `refusal` blocks, OpenAI `finish_reason="content_filter"`, content-policy
  4xx body inspection.
- No fallback action yet; the code is added to the surface so cutover
  engine can trigger on it once it ships.

### Phase 3 — Execution profile + routing rule schema changes

- Migration in harper-server: add `routing_rule.fallbacks` (jsonb,
  default `[]`) and `routing_rule.model_tier_floor` (text, default
  `'any'`) with check constraint.
- Update `contracts/execution-profile.ts` with the two new fields.
- Update the resolver
  (`apps/api/src/repositories/routing-rules.ts`) to read both columns and
  emit them.
- No editor UI yet — defaults make existing workspaces inert.
- Validation: registry-tier check on resolve (reject fallback links to
  models not in the registry, unless the registry explicitly allows
  wildcards like `openai_compatible` + `*`).

### Phase 4 — Cutover engine (runtime)

See [intelligent-cutovers-runtime-scope](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/intelligent-cutovers-runtime-scope.md).

Builds the engine, integrates it into each provider call site (Codex,
OpenClaw, LLM tool runner, LocalRelay), writes the audit row.

### Phase 5 — Audit surface

- Migration: `provider_cutover` table.
- Repository in platform:
  `apps/api/src/repositories/provider-cutovers.ts`.
- API route: `POST /api/work-items/:id/cutovers`,
  `GET /api/work-items/:id/cutovers`, and
  `GET /api/workspaces/:workspaceId/cutovers/recent`.
- Web: badge on `WorkItemDetail` showing "ran on fallback (model X →
  model Y)" if any cutover rows exist for the work item.

### Phase 6 — Editor UI

- Routing rule editor gains a "fallback chain" builder: ordered list of
  `{provider, model, credential}` rows.
- Adequacy-floor select on the routing rule editor: `any / local / mid /
  frontier`.
- Validation: editor warns if the floor would skip the primary (e.g.,
  primary is `claude-haiku-4-5` mid-tier with floor `frontier`).

## Open questions

### OQ-CU-1 — Per-task overrides vs per-agent chain

Vision Pillar 2.1 wants per-task model overrides via labels / plan
metadata. Does a per-task override fully replace the agent's fallback
chain, or does it add a new primary with the existing chain as the
fallback?

**Tentative answer**: per-task override replaces the primary only;
existing `fallbacks` and `modelTierFloor` still apply. So labeling a
task `model:gpt-4o-mini` doesn't bypass an agent that declared
`modelTierFloor: "frontier"` — it gets rejected at dispatch.

### OQ-CU-2 — Cooldown on a failed link

When a link 429s, should the engine remember and skip that link for some
window (per workspace, per credential)? Or always re-walk the chain from
the top on the next turn?

**Tentative answer**: per-credential cooldown (default 60 seconds for
429, 0 for other codes) tracked in-memory in the runtime; not persisted.
Forgotten on orchestrator restart. Avoids hammering a rate-limited
provider for the rest of the plan.

### OQ-CU-3 — Cost tracking and cutover

When a turn cuts over, both attempts may consume credits (the failed
call often still costs). How should cost accounting record this — split
across both, attribute to the successful one only, or record both
separately?

Defer to OQ-04's cost-tracking design — out of scope here.

### OQ-CU-4 — Streaming and partial-output cutover

If the model is mid-stream when the connection drops
(`provider_stream_interrupted`), do we replay the user message verbatim
against the fallback, or do we include the partial assistant output as
context to "continue from here"?

**Tentative answer**: replay the user message; discard partial output.
Partial output cross-model continuation is fraught (different tokenizers,
different formats) and the cost of replaying one turn is small.

### OQ-CU-5 — Wildcard models in the registry

The registry allows `{ provider: "openai_compatible", model: "*", tier:
"local" }` to classify all helper-served local models as `local`. Is
wildcard the right primitive, or do helper config files need to register
their actual model name explicitly?

**Tentative answer**: wildcards are fine for the `local` tier. A helper
that wants a higher classification (e.g. running Llama 3.1 70B which is
arguably mid-tier) must add an explicit registry entry through code,
not config — same trust posture as runner kinds.

## Out of scope

- **Model-tier registry as a DB table.** The registry is static in
  `contracts/`. Admin editing would mean adding a model row at runtime
  which the orchestrator wouldn't pick up without restart anyway.
- **Cross-workspace credential pooling for cutover.** A workspace's
  fallbacks come from its own credentials only; we are not building a
  shared pool of "spare API keys" across workspaces.
- **Cost-based routing.** "Pick the cheapest model that meets the
  floor" is a separate concern — see Pillar 3 vision-gap notes on
  cost-aware routing. The cutover engine deals only with availability.
- **Quality-based cutover.** "This model returned a bad answer, try a
  different one." That's a peer-review concern (Pillar 4.2), not a
  cutover concern.
- **Pre-emptive cutover.** "I see this provider is degraded on the
  status page, route around it." The engine reacts to actual errors;
  it does not consume provider status pages.
- **Helper-side fallback walking.** The helper does not itself decide to
  try a different model. It reports failures upward; the runtime cutover
  engine walks the chain. (A helper with two local models would need an
  explicit chain entry per model, not a helper-internal choice.)
- **Routing rule UI for the fallback chain** is in Phase 6 of this scope,
  but the broader routing-rule editor (Pillar 3.1) is its own scope doc.

## Success criteria

A cutover system is "done enough to ship" when:

1. A workspace can declare an execution profile of the shape
   `primary = claude-opus-4-7; fallbacks = [claude-sonnet-4-6, gpt-4o];
   floor = frontier`. When the primary 429s, the agent transparently
   continues against the next link without dropping the task.

2. A workspace can declare `floor = frontier` on a routing rule and the
   cutover engine refuses to fall through to a `mid` or `local` model
   even if the chain contains one. Instead, the task lands in the
   attention queue with reason `cutover_floor_exhausted`.

3. A `GET /api/work-items/:id/cutovers` request returns every cutover
   decision made on behalf of that work item, with from / to / trigger
   / outcome. The plan dashboard surfaces a "ran on fallback" badge
   sourced from this data.

4. The `MODEL_TIER_REGISTRY` is the single source of truth for which
   models count as which tier — runtime + platform + helper all consult
   the same data, enforced by the cross-repo enum drift check.

5. `provider_content_refused` joins the cutover-eligible code set so
   that an Anthropic refusal can route to GPT-4o (and vice versa)
   without manual intervention.

6. The audit table has rows for every cutover decision in a
   representative test run, and the rows correctly distinguish
   `fallback_succeeded` from `fallback_failed` from `escalated_floor`
   from `escalated_exhausted`.

When all six are true, Pillar 3.4 closes and we link this scope from
[`docs/vision-gaps/03-intelligent-routing.md`](../vision-gaps/03-intelligent-routing.md)
as shipped rather than "no scope doc yet."
