# Pillar 2 — LLM-Agnostic

> **Vision criterion:** A user can switch a workspace from Anthropic to
> Ollama by editing one config row, and the next plan run uses the new
> provider with no code changes.
> ([product vision](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/product-vision.md))

> **Mirrored** across
> [platform](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/vision-gaps/02-llm-agnostic.md),
> [runtime](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/vision-gaps/02-llm-agnostic.md),
> [helper](https://github.com/kmgrassi/local-runtime-helper/blob/main/docs/vision-gaps/02-llm-agnostic.md).
> Edit all three together.

## Today

12 runner kinds registered in
[`contracts/runner-kinds.ts`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/contracts/runner-kinds.ts);
execution profiles resolve model/provider/credentials from DB; no
hardcoded models in runner code; OpenAI-compatible runner ships through
the helper. The "swap workspace from Anthropic to Ollama by editing one
row" criterion is essentially met **for Anthropic, OpenAI, and local
models**.

The catch: the platform's
[`PROVIDER_REGISTRY`](https://github.com/kmgrassi/parallel-agent-platform/blob/main/contracts/provider-registry.ts)
already supports credential storage for xAI, Google (Gemini), Mistral,
Groq, OpenRouter, Together, Perplexity, Azure OpenAI, and Bedrock — but
none of those are in `KNOWN_EXECUTION_PROVIDER_IDS`. You can save a
Gemini key; you can't dispatch a turn to Gemini. That gap is 2.2 below.

## Gap areas

### 2.1 Per-task model overrides via labels / plan metadata

Today, model choice resolves at the **agent** level via the execution
profile. The vision describes per-task overrides driven by labels
(`model:local-llama`) or plan metadata so a single plan can route some
tasks to a frontier model and others to a local one without
reconfiguring the agent. Today's plan task schema doesn't carry a model
override field and the resolver doesn't consult one.

This also has a credentials dimension — if a workspace has multiple
provider keys, overrides must reference `credential_id` (not API keys
directly) to avoid leaking secrets in labels.

**Active scope docs:**
- [oq-04-per-task-model-overrides-credentials (open question)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/open-questions/oq-04-per-task-model-overrides-credentials.md)
  — design call on the override shape and credentials path.
- [oq-04-credentials-pr-plan (reference)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/reference/oq-04-credentials-pr-plan.md)
  — staged PR plan derived from the open question.
- [unified-execution-profile-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/unified-execution-profile-scope.md)
  — current execution-profile work; the override surface plugs in here.
- [unified-execution-profile-runtime-scope (runtime)](https://github.com/kmgrassi/parallel-agent-runtime/blob/main/docs/unified-execution-profile-runtime-scope.md)
  — runtime side of the same work.

### 2.2 Execution adapters for credential-only providers

Nine providers in `PROVIDER_REGISTRY` have credential-storage
scaffolding but no execution adapter — `xai`, `google`, `mistral`,
`groq`, `openrouter`, `together`, `perplexity`, `azure`, `bedrock`.
Closing this gap is what makes the LLM-agnostic pillar's criterion
("switch a workspace from Anthropic to Ollama by editing one config
row") generalize to any of those providers. It's also what makes the
[3.4 Intelligent cutovers](03-intelligent-routing.md#34-intelligent-cutovers)
chains useful for cross-vendor fallback (today a chain can only
include OpenAI, Anthropic, and local; once 2.2 ships it can include
Gemini, Grok, Mistral, etc.).

**Active scope docs:**
- [provider-execution-adapter-rollout-scope (platform)](https://github.com/kmgrassi/parallel-agent-platform/blob/main/docs/active/provider-execution-adapter-rollout-scope.md)
  — phased rollout: generalized OpenAI-compatible cloud adapter (xAI,
  Mistral, Groq, OpenRouter, Together, Perplexity, Azure), native
  Gemini adapter, native Bedrock adapter. Per-provider credential
  validation. Model-catalog discovery endpoint.

> **Cross-cutting note.** Cutover fallback chains (3.4) reference
> providers that are in the registry but may not have execution
> adapters yet. The cutover engine handles this by skipping
> not-yet-executable links during the walk and recording the skip in
> the audit row — visible but not task-breaking. As 2.2 phases ship,
> more cross-vendor chains become live without code changes in 3.4.
