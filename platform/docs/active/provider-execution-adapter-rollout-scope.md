# Provider Execution Adapter Rollout — Scope

## Goal

The codebase has credential-storage scaffolding for nine LLM providers
that the runtime cannot actually dispatch a turn to today. Routing
rules and the
[intelligent-cutovers tier registry](./intelligent-cutovers-scope.md)
list Gemini, Grok, Mistral, Groq, OpenRouter, Together, Perplexity,
Azure OpenAI, and Bedrock — but only `openai`, `anthropic`,
`openai_codex`, and `openai_compatible` (local) are in
`KNOWN_EXECUTION_PROVIDER_IDS`. The remaining providers are credential
ghosts: you can store a key, but no agent can use it.

This scope closes that gap. The goal is **execution parity with the
credential-storage list** so that the LLM-agnostic pillar's "switch a
workspace from Anthropic to Ollama by editing one config row" criterion
extends to "switch to Gemini, or Grok, or Mistral, by editing one row."

Specifically:

1. **A generalized OpenAI-compatible execution adapter** in the runtime
   that subsumes most new providers (Mistral, Groq, OpenRouter, Together,
   Perplexity, xAI, Azure OpenAI). These all speak the OpenAI
   chat/completions or messages shape with minor per-provider quirks
   (base URL, auth header, occasional response-format deltas).
2. **A native Gemini adapter** for Google's API. Gemini's native API
   (Vertex / Generative Language) differs enough from OpenAI-compat
   that a shim is leakier than a small native client.
3. **A native Bedrock adapter** for AWS's signed-request model. Bedrock
   needs AWS SigV4 and model-family-specific payloads (Anthropic on
   Bedrock looks different from Llama on Bedrock).
4. **Per-provider config** — a registry of base URLs, auth header
   styles, model catalog endpoints, and quirks, in one source of truth.
5. **Per-provider credential validation** at save time — today only
   OpenAI is validated; everything else lands in the DB silently.
6. **Model catalog discovery** — when a user adds a provider, the UI
   shows that provider's actual available models, not a hardcoded list.
7. **Per-provider error-code mapping** — each adapter emits the
   canonical `provider_*` codes
   (`provider_rate_limited`, `provider_overloaded`,
   `provider_content_refused`, etc.) so the
   [cutover engine](./intelligent-cutovers-scope.md) treats failures
   identically across providers.

## Current state

### Providers with execution support today

From `contracts/provider-registry.ts` `KNOWN_EXECUTION_PROVIDER_IDS`:

| Provider | Adapter |
|---|---|
| `openai` | Native; `LlmToolRunner` → OpenAI Responses API |
| `anthropic` | Native; `LlmToolRunner` → Anthropic Messages API |
| `openai_codex` | OAuth flow + OpenAI API; via Codex worker |
| `codex` | Codex subprocess (CLI wrapper) |
| `openai_compatible` | Used by helper for local relay; runtime side wired through `LocalRelay` |
| `openclaw` / `computer_use` / `local` | Specialty execution, not LLM-completion |

### Providers with credentials but no execution

From `contracts/provider-registry.ts` `CREDENTIAL_PROVIDER_IDS` minus
`KNOWN_EXECUTION_PROVIDER_IDS`:

| Provider | Credential support | Execution adapter |
|---|---|---|
| `xai` | ✅ (XAI_API_KEY) | ❌ |
| `google` | ✅ (GEMINI_API_KEY, GOOGLE_API_KEY) | ❌ |
| `mistral` | ✅ (MISTRAL_API_KEY) | ❌ |
| `groq` | ✅ (GROQ_API_KEY) | ❌ |
| `openrouter` | ✅ (OPENROUTER_API_KEY) | ❌ |
| `together` | ✅ (TOGETHER_API_KEY) | ❌ |
| `perplexity` | ✅ (PERPLEXITY_API_KEY) | ❌ |
| `azure` | ✅ (AZURE_OPENAI_API_KEY) | ❌ |
| `bedrock` | ✅ (model catalog only) | ❌ |

### Existing infrastructure we build on

- **`model_client` behavior** in the runtime — `llm_tool_runner.ex:364-366`
  dispatches `session.model_client.create_response()`. The behavior
  contract is the right abstraction for new adapters; each new adapter
  is a new module implementing the behavior.
- **Provider validation pattern** — `apps/api/src/provider-validation.ts`
  has `validateOpenAiCredential()` that hits `/v1/models`. Same pattern
  generalizes to any OpenAI-compatible provider with a `/models` endpoint.
- **OpenAI-compatible local runner** — the helper's
  `internal/runner/openai_compatible/` and the relay protocol already
  prove the OpenAI-compat shape works for inference. The cloud
  generalization mirrors this with different base URLs and auth.
- **Canonical error codes** — `observability.ex:15-30` and `:225-245`
  already define the `provider_*` code set that adapters emit. New
  adapters reuse this; no new error vocabulary needed (other than the
  `provider_content_refused` code added in the cutover scope).
- **Cross-repo enum drift check** — adding a provider to
  `KNOWN_EXECUTION_PROVIDER_IDS` will be caught by
  `scripts/check-cross-repo-enums.mjs` against the harper-server DB
  check constraints.

### What's missing

- **No shared OpenAI-compatible cloud adapter.** The existing
  `openai_compatible` provider is wired through the relay (local-only).
  A cloud version that takes `base_url`, `auth_header`, and
  `model_catalog_url` from config does not exist.
- **No Gemini adapter.** Native API client missing.
- **No Bedrock adapter.** AWS SigV4, IAM credentials, model-specific
  payloads all absent.
- **No per-provider model catalog.** Today's model-picker UIs use
  hardcoded option lists per provider. There's no
  `GET /api/providers/:provider/models` that consults the provider's
  own model list.
- **No per-provider validation** for any provider beyond OpenAI.
  Anthropic, xAI, Google, Mistral, etc. credentials save without a
  call to verify the key works.
- **No execution-availability check** at routing-rule save time —
  today you can save a routing rule with `provider: "google"` and it
  will fail at dispatch, not at save.

## Proposed model

### Two adapter families

```
┌──────────────────────────────────────────────────────────────────┐
│  OpenAICompatibleCloud (one adapter, per-provider config)        │
│  • base_url, auth_header_style, model_catalog_url per provider   │
│  • Speaks /chat/completions or /messages OpenAI shape            │
│                                                                  │
│  Providers: xai, mistral, groq, openrouter, together,            │
│             perplexity, azure                                    │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  GeminiNative (own adapter)                                      │
│  • Vertex AI / Generative Language API                           │
│  • Different message format, function-calling syntax, streaming  │
│                                                                  │
│  Providers: google                                               │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  BedrockNative (own adapter)                                     │
│  • AWS SigV4 signing, IAM credentials                            │
│  • Per-model-family payload shape (Anthropic, Llama, Mistral,    │
│    Amazon Nova all differ on Bedrock)                            │
│                                                                  │
│  Providers: bedrock                                              │
└──────────────────────────────────────────────────────────────────┘
```

### Per-provider config

New file `contracts/provider-execution-config.ts` — declarative table
of how to reach each provider:

```typescript
export const PROVIDER_EXECUTION_CONFIG: Record<RegisteredProvider, {
  family: "openai_compat_cloud" | "anthropic_native" | "gemini_native"
        | "bedrock_native" | "openai_codex" | "codex_cli"
        | "openai_compatible_relay" | "specialty";
  baseUrl?: string;
  authHeader?: "bearer" | "x-api-key" | "azure_api_key" | "aws_sigv4";
  modelCatalogUrl?: string;
  notes?: string;
}> = {
  openai:     { family: "openai_compat_cloud", baseUrl: "https://api.openai.com/v1",
                authHeader: "bearer", modelCatalogUrl: "/v1/models" },
  anthropic:  { family: "anthropic_native", baseUrl: "https://api.anthropic.com/v1",
                authHeader: "x-api-key", modelCatalogUrl: "/v1/models" },
  xai:        { family: "openai_compat_cloud", baseUrl: "https://api.x.ai/v1",
                authHeader: "bearer", modelCatalogUrl: "/v1/models" },
  google:     { family: "gemini_native",
                baseUrl: "https://generativelanguage.googleapis.com/v1beta",
                authHeader: "x-api-key",
                modelCatalogUrl: "/models" },
  mistral:    { family: "openai_compat_cloud", baseUrl: "https://api.mistral.ai/v1",
                authHeader: "bearer", modelCatalogUrl: "/v1/models" },
  groq:       { family: "openai_compat_cloud", baseUrl: "https://api.groq.com/openai/v1",
                authHeader: "bearer", modelCatalogUrl: "/v1/models" },
  openrouter: { family: "openai_compat_cloud", baseUrl: "https://openrouter.ai/api/v1",
                authHeader: "bearer", modelCatalogUrl: "/v1/models" },
  together:   { family: "openai_compat_cloud", baseUrl: "https://api.together.xyz/v1",
                authHeader: "bearer", modelCatalogUrl: "/v1/models" },
  perplexity: { family: "openai_compat_cloud", baseUrl: "https://api.perplexity.ai",
                authHeader: "bearer",
                notes: "no model catalog endpoint; use registry list" },
  azure:      { family: "openai_compat_cloud",
                authHeader: "azure_api_key",
                notes: "base_url is per-deployment, set on credential" },
  bedrock:    { family: "bedrock_native", authHeader: "aws_sigv4",
                notes: "region + IAM via credential payload; no static base_url" },
  // existing
  openai_codex: { family: "openai_codex" },
  codex:        { family: "codex_cli" },
  openai_compatible: { family: "openai_compatible_relay" },
  openclaw:     { family: "specialty" },
  computer_use: { family: "specialty" },
  local:        { family: "specialty" },
};
```

Runtime mirror at
`apps/orchestrator/lib/symphony_elixir/provider_execution_config.ex`,
regenerated via `pnpm run supabase:schema:sync`.

### Runtime — adapter modules

`apps/orchestrator/lib/symphony_elixir/runner/model_client/`:

- `openai_compat_cloud.ex` — single adapter; takes provider id at
  construction time and reads config from the registry. Handles bearer
  vs x-api-key vs azure_api_key auth styles. Used by xai, mistral, groq,
  openrouter, together, perplexity, azure.
- `gemini.ex` — native Gemini client.
- `bedrock.ex` — AWS Bedrock client; uses an Elixir AWS SigV4 library.

Each adapter implements the existing `model_client` behavior — same
call signature as the OpenAI and Anthropic adapters today. Cutover
engine and tool runner consume them identically.

### Platform — per-provider validation

`apps/api/src/provider-validation.ts` gains:

```typescript
export async function validateProviderCredential(
  provider: RegisteredProvider,
  key: string,
  config?: { baseUrl?: string; region?: string }
): Promise<{ ok: true } | { ok: false; reason: string }>;
```

Per-provider implementation:

- **OpenAI-compat-cloud providers** (xai, mistral, groq, openrouter,
  together, azure): GET on `{baseUrl}/models` with the appropriate auth
  header. 200 → ok; 401/403 → bad key; other → unknown.
- **Perplexity**: no `/models` endpoint; do a minimal `/chat/completions`
  ping with `max_tokens: 1`.
- **Google**: GET on `{baseUrl}/models?key={apiKey}` (Gemini uses
  query-param auth).
- **Bedrock**: validate via `sts:GetCallerIdentity` to verify IAM
  credentials work; separately ping a known Bedrock model with
  zero-cost noop.
- **Existing openai / anthropic**: unchanged.

Validation runs on credential save in the credentials-streamlining
flow (see
[`credentials-streamlining-scope.md`](./credentials-streamlining-scope.md)
ambiguity #7). Failures surface in the UI; success caches a
`validated_at` timestamp.

### Platform — model catalog discovery

New endpoint:

```
GET /api/providers/:provider/models?credentialId=<id>
→ 200 [{ id: string, label?: string, contextWindow?: number }, ...]
```

Implementation pattern:

- Look up `PROVIDER_EXECUTION_CONFIG[provider].modelCatalogUrl`.
- Use the credential identified by `credentialId` to fetch the list.
- Cache the response per `(provider, credential_id)` for 1 hour (in
  Redis, or the existing route cache).
- For providers without a catalog endpoint (Perplexity), return the
  static list from `MODEL_TIER_REGISTRY` filtered to that provider.

Used by the routing-rule editor model picker (Pillar 3.1).

### Platform — routing-rule save validation

When a routing rule's `provider` is in
`KNOWN_EXECUTION_PROVIDER_IDS`, save proceeds normally. When it's a
provider that has credentials-only scaffolding but no execution
adapter (today: all 9 listed), the API responds with 400 and a clear
error pointing to this scope doc. After the rollout completes, the
`KNOWN_EXECUTION_PROVIDER_IDS` list expands to include all providers
and the validation passes.

## DB migrations

Harper-server changes for this scope are enumerated in
[`harper-server/docs/vision-gaps-migrations-scope.md`](https://github.com/harper-hq/harper-server/blob/main/docs/vision-gaps-migrations-scope.md)
(M8). Most providers (xAI, Google, Mistral, Groq, OpenRouter,
Together, Perplexity, Azure) are already permitted by the existing
`routing_rule.provider` CHECK and `credential.kind` CHECK constraints
— so the only DB change is M8 (adding `bedrock` to the routing-rule
provider CHECK) which ships with Phase F.

## Phased migration

Rollout is provider-batched, grouped by adapter family. Each phase is
end-to-end (contracts → runtime adapter → platform validation →
model-catalog endpoint → at least one smoke test).

### Phase A — Provider execution config + generalized adapter shell

- Add `contracts/provider-execution-config.ts` and runtime mirror.
- Add `apps/orchestrator/lib/symphony_elixir/runner/model_client/openai_compat_cloud.ex`
  shell (constructor takes provider id; reads config; no per-provider
  bugs yet).
- Refactor existing OpenAI adapter (`runner/model_client/openai.ex`)
  to reuse the shell where it can, or leave alone if cleaner.
- No new providers in `KNOWN_EXECUTION_PROVIDER_IDS` yet.

### Phase B — xAI (Grok)

Smallest blast radius; OpenAI-compat shape; easy validation.

- Add `xai` to `KNOWN_EXECUTION_PROVIDER_IDS` in contracts.
- Harper-server migration to extend `routing_rule.provider` check
  constraint.
- Per-provider validation function.
- Model catalog endpoint pass-through.
- Smoke test: routing rule → `xai` + `grok-4` → run a trivial agent
  turn end-to-end.
- Tier registry entries already present from the cutover scope.

### Phase C — Mistral, Groq, OpenRouter, Together, Perplexity

Batched because they share the OpenAI-compat-cloud family. Each
provider individually:

- Add to `KNOWN_EXECUTION_PROVIDER_IDS`.
- Harper-server migration (one migration per batch).
- Validation function (Perplexity uses the `/chat/completions` ping
  variant).
- Model catalog endpoint pass-through (Perplexity uses tier-registry
  fallback).
- Smoke test per provider.

### Phase D — Azure OpenAI

Azure deserves its own phase because base URL is per-deployment, auth
header is `api-key` (not bearer), and model identifiers are
deployment-scoped. The credential payload needs to carry the resource
URL, deployment id, and API version.

- Extend credential row shape for Azure to include
  `{ endpoint, deployment_id, api_version }` alongside the key.
- Adjust validation and config lookup to read those fields.
- Smoke test against an Azure subscription's deployment.

### Phase E — Gemini (Google)

Native adapter, biggest single-provider build in this scope.

- New `apps/orchestrator/lib/symphony_elixir/runner/model_client/gemini.ex`.
- Message format mapping: OpenAI shape → Gemini `contents` array;
  function-calling translation; safety-setting passthrough.
- Streaming: Gemini's SSE differs from OpenAI's; map to internal stream
  shape.
- Validation against `/v1beta/models?key=<key>`.
- Tool-call carry-over: ensure cutover from a Gemini turn to a non-
  Gemini fallback preserves tool-call state.
- Smoke test: routing rule → `google` + `gemini-2.5-pro` → run a
  tool-calling agent turn end-to-end.

### Phase F — Bedrock

Native adapter; the most operationally involved.

- New `apps/orchestrator/lib/symphony_elixir/runner/model_client/bedrock.ex`.
- AWS SigV4 signing via an Elixir AWS lib (e.g. `ex_aws`).
- Credential shape: IAM access key + secret + region (not a single
  API key).
- Per-model-family payload mapping: Bedrock requires Anthropic-on-
  Bedrock payloads to use the Anthropic shape, Llama-on-Bedrock to
  use the Meta shape, etc. The adapter dispatches on model id prefix.
- Validation via `sts:GetCallerIdentity` + a `bedrock-runtime:InvokeModel`
  dry-run.
- Smoke test per model family.

### Phase G — Editor UI surfacing

Already-shipped routing-rule editor (Pillar 3.1) gains:

- Provider picker shows all newly-executable providers.
- Per-provider credential picker shows the right credentials.
- Model picker uses `GET /api/providers/:provider/models`.
- Routing-rule save no longer errors on previously-credential-only
  providers.

## Open questions

### OQ-PA-1 — Should the OpenAI-compat-cloud adapter live in the helper or the runtime?

The helper already has `internal/runner/openai_compatible/` (Go) for
local models. The cloud version of the same shape could live there too
— the helper would proxy cloud requests over the relay. But that adds
relay-hop latency and routes cloud traffic through user machines.

**Tentative answer**: cloud adapter in the runtime, not the helper.
Helper stays local-only. The shape is similar but the deployment
model is different (cloud adapter runs in the orchestrator process,
helper adapter runs on the user's box).

### OQ-PA-2 — Vertex AI vs Generative Language API for Gemini

Google has two API surfaces for Gemini: Vertex AI (enterprise, IAM,
regional endpoints) and Generative Language API (consumer, single
API key). They have different authentication and slightly different
features.

**Tentative answer**: ship the Generative Language API first (the
single-key flow matches every other provider's UX). Vertex AI is a
fast-follow that effectively duplicates the Bedrock phase's pattern
(IAM, regions, signed requests).

### OQ-PA-3 — Bedrock as a credential vs Bedrock as a region-scoped runtime

`PROVIDER_REGISTRY.bedrock` has `modelCatalog: true` but no
`credential` or `execution` flag set. Today Bedrock is half-wired —
the catalog can list Bedrock models but there's no credential
storage shape for IAM keys. Phase F has to add the credential shape
too.

**Tentative answer**: extend `CREDENTIAL_PROVIDER_IDS` to include
`bedrock`, with a Bedrock-specific credential payload containing
an access key id, secret access key, and region. Same
storage table, different payload shape inside
`credential.key_value`.

### OQ-PA-4 — Should we wait for the credentials-streamlining work to land before adding providers?

[Credentials-streamlining-scope](./credentials-streamlining-scope.md)
collapses the four current credential storage shapes into one. Adding
five new providers before that work lands would worsen the same drift
it's trying to fix.

**Tentative answer**: Phase A (config) can land independently. Phases
B–F should wait for credentials-streamlining Phase 1 (the unified
storage shape) before adding their provider-specific credential
fields. This avoids re-doing the work post-streamlining.

### OQ-PA-5 — Per-provider rate-limit signatures

The cutover engine treats `provider_rate_limited` uniformly across
providers, but each provider's 429 carries different headers
(`Retry-After`, `x-ratelimit-*`, etc.). Do we extract these into
cooldown duration overrides per provider?

**Tentative answer**: yes, but as a Phase H follow-on. Phase B–F
ship with the default 60s cooldown; Phase H adds per-provider
retry-after parsing.

## Out of scope

- **OAuth flows for any of these providers.** OpenAI Codex (ChatGPT
  OAuth) is the only OAuth provider in scope; see OQ-11. Other
  providers stay API-key only in this scope.
- **Provider-hosted file storage / RAG.** Anthropic's file API,
  OpenAI's Assistants files, Gemini's caching — not in scope. We pass
  message arrays; provider-side state is the provider's problem.
- **Image / audio / video modalities.** Text-and-tool-calls only.
  Multimodal adapters are a separate scope.
- **Provider-specific feature parity.** Anthropic's "computer use"
  beta, Gemini's grounding, OpenAI's o-series reasoning effort —
  features that only exist on one provider don't get cross-mapped.
  Use them through the native adapter, not via the shared shape.
- **Cost tracking per provider.** Cost accounting is OQ-04's territory.
- **Bedrock cross-region failover.** A Bedrock credential is bound to
  one region. Multi-region Bedrock is a separate concern.

## Success criteria

1. A workspace can save a Google / xAI / Mistral / Groq / OpenRouter /
   Together / Perplexity / Azure / Bedrock credential and the
   credential is validated at save time. Invalid keys are rejected
   with a clear error.
2. A routing rule with `provider: "google"` and `model: "gemini-2.5-pro"`
   resolves to an executable execution profile and the orchestrator
   runs an agent turn against Gemini end-to-end.
3. `KNOWN_EXECUTION_PROVIDER_IDS` includes all credential-storing
   providers. The cross-repo enum drift check passes against the
   harper-server `routing_rule.provider` check constraint.
4. Each new adapter emits canonical `provider_*` error codes on
   failure. The [cutover engine](./intelligent-cutovers-scope.md)
   walks a fallback chain that includes Gemini → xAI → OpenAI
   identically to the existing OpenAI-only path.
5. The routing-rule editor shows all executable providers in the
   picker and lists each provider's actual model catalog (cached for
   1 hour).
6. A smoke test per provider exists in CI, gated behind a
   `CI_PROVIDER_SMOKE=1` flag, that runs a single agent turn against
   that provider's API.
7. The vision-gap [Pillar 2.2](../vision-gaps/02-llm-agnostic.md#22-execution-adapters-for-credential-only-providers)
   reads "shipped" and points to this scope doc moved to `docs/shipped/`.

When all seven are true, "switch a workspace from Anthropic to Ollama
to Gemini to xAI by editing one config row" is true, and Pillar 2's
LLM-agnostic criterion holds for every provider the codebase
acknowledges.
