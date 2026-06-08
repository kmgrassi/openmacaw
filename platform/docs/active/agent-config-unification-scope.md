# Agent Model & Runtime Configuration Unification — Platform Scoping Document

## Problem

The agent settings detail page exposes an agent's model/provider/credential/runtime
configuration through **five overlapping cards**: Identity, Runtime, Saved
Credentials, Execution Credential Reference, and Model Policy. The user can set
the **model in three of them**, the **provider in two**, and **credentials across
three**, each writing a different slice of the underlying state through a
different mutation. The slices can diverge until a page reload, and the user has
no single, obvious place to answer the only question they actually have: *what
model does this agent run, and what do I need to make that work?*

The most common real task — "switch this agent from an OpenAI model to a local
model" (and the reverse) — currently requires touching multiple cards and
reasoning about provider, runner kind, and credential interactions that should be
derivable from the model choice alone.

## Key insight — the data model is already unified; the UI fragments it

Under the hood an agent's execution configuration is **already** stored in one
place: a routing rule named `agent:{agentId}:execution-profile`
(`upsertAgentCredentialReferenceRule`,
`apps/api/src/repositories/routing-rules.ts`) with columns `runner_kind`,
`provider`, `model`, `credential_id` / `credential_alias`. The model is then
**duplicated** into `agent.model_settings.primary` and **triplicated** into
`gateway_config.runners[0]`.

A model choice fully determines the rest:

```
model  →  provider  →  execution location (cloud vs local)  →  needs a credential?  →  runner kind / transport
```

There is no need to expose provider, runner kind, and credential as independent
top-level controls. This work is therefore **mostly a UI consolidation plus
retiring redundant writes**, with an optional backend de-duplication as a
follow-up.

### Where each field is editable today (the redundancy)

| Card | Component | Sets | Writes to |
| --- | --- | --- | --- |
| Identity | `AgentDetail/AgentIdentityEditor.tsx` | "Primary model" | `agent.model_settings` (`PATCH /api/stored-agents/:id`) |
| Runtime | `AgentDetail/AgentRuntimeEditor.tsx` | Provider + Model | execution-profile rule + `model_settings` + `gateway_config` (`PUT /api/stored-agents/:id/runtime-profile`) |
| Saved Credentials | `settings/AgentCredentials.tsx` | API keys / OAuth + aliases | `credential`, `credential_alias` |
| Execution Credential Reference | `settings/CredentialPicker.tsx` | which credential to use | rule `credential_id` / `credential_alias` (`PUT …/credential-reference`) |
| Model Policy | `settings/agent-model-policy/AgentModelPolicyCard.tsx` | runner kind (Codex / Claude Code / Local model coding / Local relay) + model + credential | `model_settings` **and** the rule |

Composed in `settings/AgentDetail.tsx` (Identity, Runtime) and
`AgentDetail/AgentCredentialsPanel.tsx` (Execution Credential Reference, Saved
Credentials, Model Policy).

## Goal

A single **"Model & Runtime"** card, driven by one model picker, that:

1. Is the **only** place to set what an agent runs.
2. Adapts an inline **requirements checklist** to the chosen model — a credential
   for a cloud model, a running local runtime for a local model — and walks the
   user through satisfying it without leaving the card.
3. Makes the **OpenAI ⇄ local** switch a single re-pick in one dropdown.

Identity slims to name + type. "Saved Credentials" stops being a per-agent card;
credential entry happens inline when a chosen model needs one, and a
workspace-level credentials manager lives elsewhere in settings.

## Proposed UX (target state)

One model picker that unions hosted models, cloud coding runtimes, and detected
local models. Selecting one drives an adaptive requirements block and a resolved
summary line. For **coding agents**, the runner choice (Codex vs Claude Code vs a
local model) appears *as entries in the same picker* rather than a separate Model
Policy control.

```
┌─ Model & Runtime ─────────────────────────────────────────┐
│ Model   [ GPT-4o  (OpenAI · cloud)            ▼ ]          │
│         ┌───────────────────────────────────────┐         │
│         │ HOSTED        GPT-4o / Claude Sonnet…  │         │
│         │ CODING        Codex / Claude Code       │        │
│         │ LOCAL (coder-box)  qwen3-coder ● running│        │
│         └───────────────────────────────────────┘         │
│ Requirements                                               │
│   ✓ OpenAI credential — “My OpenAI key”   [change]         │
│ ▸ Advanced (runner kind, endpoint, fallback)               │
│                                       [ Save ]             │
└── Runs GPT-4o on OpenAI (cloud) using “My OpenAI key”. ────┘
```

- **Switch to local** → Requirements swaps to `✓ Local runtime running on
  ‘coder-box’ — no API credential needed`.
- **Cloud model, no key yet** → Requirements shows `✗ OpenAI credential
  required` with an inline "Add API key" form (key + scope + validate-and-save),
  Save disabled until satisfied.

Full mockups belong in the Phase 1 PR description; this doc fixes the model and
the API surface.

---

## Phasing (built to run in parallel)

The three phases are deliberately decoupled. **Phase 1 (UI) and Phase 3
(backend de-dup) can proceed concurrently** because Phase 1 builds on the
`runtime-profile` write — which already fans out to all three stores — extended
with one additive field (`runnerKind`, see below); Phase 3 changes how those
stores are *derived* without changing that write's external shape. Phase 2 slots
into the Phase 1 card.

```
Phase 1 (web UI) ─────────────┐
                              ├─ integrate
Phase 2 (inline credential) ──┘
Phase 3 (backend de-dup) ───── independent; derives, doesn't reshape the write
```

---

## Phase 1 — Unified card (UI consolidation, one additive write field)

**Outcome:** one "Model & Runtime" card replaces Runtime + Model Policy +
Execution Credential Reference; Identity loses its model field; everything writes
through a single `PUT /api/stored-agents/:id/runtime-profile`, extended to carry
an explicit `runnerKind`.

### API
- **New read:** `GET /api/stored-agents/:id/model-config` → resolved
  `{ model, provider, location, runnerKind, credential, requirements[] }`.
  Mostly assembles existing `execution-profile-resolver` output plus
  `configurationStatus.missing` into a render-ready checklist. Low effort —
  reuse, don't re-derive.
- **New catalog:** `GET /api/models?workspaceId=…` unioning the hosted catalog
  (today behind `HostedModelSelect`) with detected local models (today a
  separate listing inside `AgentRuntimeEditor`), each tagged
  `{ provider, location, running }`.
- **Extend the write (prerequisite to retiring Model Policy):**
  `AgentRuntimeProfileUpdateRequest` today carries only
  `workspace/provider/model/credentialRef/localEndpointUrl`, and
  `updateAgentRuntimeProfile` *derives* `runner_kind` from agent type + provider
  (`runnerKindForRuntimeProfile`: `coding+local → local_model_coding`, otherwise
  the agent-type default — so a cloud coding agent always becomes `codex`). It
  therefore **cannot express the coding-runner choice** the unified picker
  promises (Codex vs **Claude Code** vs **local relay**) — that distinction
  currently only flows through the Model Policy / credential-reference path
  (`upsertAgentCredentialReferenceRule`, which takes an explicit `runnerKind`).
  **Add an optional `runnerKind` to the request**; when present
  `updateAgentRuntimeProfile` uses it verbatim, when omitted it falls back to
  today's derivation (so non-coding callers are unchanged). Without this,
  retiring Model Policy silently coerces Claude Code / local relay selections to
  `codex`. This must land **before** PLAT-2 removes the old card.

### Web
- New `AgentDetail/AgentModelRuntimeCard.tsx` (model picker + requirements +
  advanced disclosure + summary line).
- Remove the model field from `AgentIdentityEditor.tsx`.
- Retire `AgentRuntimeEditor.tsx`, `CredentialPicker.tsx`
  (Execution Credential Reference), and `AgentModelPolicyCard.tsx` from the page;
  fold their behavior into the new card. Keep their write helpers only if reused.
- Recompose `AgentDetail.tsx` / `AgentCredentialsPanel.tsx`.

### Out of scope for Phase 1
- No DB/schema changes (the `runnerKind` write extension is additive and
  request-only — the rule already has the column). Workspace-level credential
  management stays where it is (only the *per-agent* credential UI moves inline
  in Phase 2).

### Verification
- Set a cloud model, attach a credential, save; reload and confirm persistence.
- Switch the same agent to a local model and back; confirm runner kind /
  credential clear and re-populate correctly and the agent starts.
- For a coding agent, pick **Claude Code** and **local relay** in turn; confirm
  the saved `runner_kind` is `claude_code` / `local_relay` (not coerced to
  `codex`) and survives reload — the regression the `runnerKind` extension
  guards against.
- Confirm no remaining UI path can set the model except the new card.

---

## Phase 2 — Inline credential creation in the one flow

**Outcome:** when a chosen cloud model has no credential, the user enters the key
**inside the card** and one Save both stores the credential and attaches it — no
hop to Saved Credentials → alias → reference.

### API
- Extend `PUT /api/stored-agents/:id/runtime-profile` to optionally accept an
  inline credential to create (key/format/scope), creating the `credential` row
  and pointing the rule at it in a single call. Validation reuses
  `validateCredentialRecord` so the same checked result surfaces in the card.

### Web
- Inline "Add API key" form in the requirements block (key + scope toggle +
  validate-and-save), gating Save until the requirement is satisfied.
- Per-agent credential entry now lives here; the standalone per-agent
  "Saved Credentials" card is removed. A workspace-level credentials manager
  remains in settings for cross-agent reuse.

### Depends on
- Phase 1 card existing. The endpoint extension can be built in parallel and
  wired in once the card lands.

### Verification
- New agent + cloud model + no existing key → enter key in card → single Save →
  credential created, attached, validated, agent starts.

---

## Phase 3 — De-duplicate the model at the data layer (backend only)

**Outcome:** the execution-profile routing rule becomes the single source of
truth for an agent's model/provider/runner; `agent.model_settings.primary` and
`gateway_config.runners[0]` are **derived at read time** instead of stored, so
the three copies can no longer diverge.

### API / data model
- Make read paths (`execution-profile-resolver`, setup/auth state, gateway
  config assembly) derive model/provider from the rule rather than from
  `model_settings` / `gateway_config`.
- Stop writing the duplicate copies in `updateAgentRuntimeProfile` (and audit
  every other writer of `model_settings.primary` and `gateway_config.runners`).
- Migration/backfill: reconcile any agents whose stored copies disagree with
  their rule, choosing the rule as canonical; document the precedence.

### Independent of Phases 1–2
- The `runtime-profile` write contract is unchanged from the caller's view, so
  this can land before, after, or alongside the UI work. It is the
  highest-risk phase (touches resolution + every consumer of the duplicated
  fields) and should carry the broadest test pass.

### Verification
- Resolver returns the same profile after the duplicate columns stop being
  written. Existing agents resolve identically pre/post backfill. No consumer
  reads `model_settings.primary` / `gateway_config.runners[0]` for the model.

---

## PR sequence

- **PLAT-1 (Phase 1):** `model-config` read + `models` catalog endpoints, **and
  the `runnerKind` write extension** (additive, backward-compatible). This is a
  hard prerequisite for PLAT-2.
- **PLAT-2 (Phase 1):** unified `AgentModelRuntimeCard`; retire Runtime /
  Model Policy / Execution Credential Reference; slim Identity. Must not land
  before PLAT-1's `runnerKind` extension, or coding-runner choices regress to
  `codex`.
- **PLAT-3 (Phase 2):** inline credential create on the write endpoint + card
  form; remove per-agent Saved Credentials card.
- **PLAT-4 (Phase 3):** derive duplicated fields from the rule; stop writing
  copies; backfill migration; consumer audit.

PLAT-1/2 and PLAT-4 are parallelizable; PLAT-3 integrates into PLAT-2's card.

## Open questions / decisions

- **Picker grouping & "advanced":** confirm the model picker is the single
  control for coding-runner choice (Codex / Claude Code / local) vs. keeping a
  small advanced override for runner kind / endpoint / fallback.
- **Credential scope default** in the inline form: agent-only vs workspace.
- **Phase 3 precedence:** confirm the routing rule is canonical when stored
  copies disagree (this doc assumes yes).

## References

- Resolver: `apps/api/src/services/execution-profile-resolver.ts`,
  `.../execution-profile-resolver/routing-rules.ts`
- Agent execution-profile rule: `apps/api/src/repositories/routing-rules.ts`
  (`upsertAgentCredentialReferenceRule`)
- Runtime write: `apps/api/src/services/agent-runtime-profile.ts`
  (`updateAgentRuntimeProfile`)
- Runner kinds: `contracts/runner-kinds.ts` (`RUNNER_REGISTRY`)
- Providers: `contracts/provider-registry.ts`
- Related: [active/agent-config-error-ux-plan.md](agent-config-error-ux-plan.md)
  (error-to-fix linking shares the requirements/checklist surface).
