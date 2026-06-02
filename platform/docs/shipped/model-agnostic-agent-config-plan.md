# Model-Agnostic Agent Configuration — Platform PRs

## Problem

Agents should not be hardcoded to a specific model or provider. Users must be
able to choose the model and attach stored credentials from the platform UI.
The credential system already exists (`credential` table, `agent_tool`
assignments, `AgentCredentials.tsx` dropdown), but the agent setup pages do not
fully leverage it: the Planning Agent has no model/credential picker, and the
model selector does not filter by available credentials.

---

## PR 1 — Credential picker in agent settings

### Goal

When configuring any agent, show a dropdown of **stored** credentials (from the
`credential` table) filtered by provider. The user selects an existing key —
they never re-enter one. Display `provider name + label` (e.g.
"Anthropic — sk-••••a1b2"), never the raw secret.

### Key references

| File | What it does |
|---|---|
| `apps/web/src/components/settings/AgentCredentials.tsx` | Already renders a credential dropdown (lines 138-148) with `credentialOptions` built from `credentials` and `aliases`. |
| `contracts/credentials.ts` | `CREDENTIAL_PROVIDERS` / `CREDENTIAL_PROVIDER_REGISTRY` — canonical list of supported providers (openai, anthropic, xai, google, mistral, groq, openrouter, together, perplexity, azure). |
| `apps/api/src/services/credential-resolver.ts` | Server-side credential resolution. |

### Changes

1. **Extract a reusable `<CredentialPicker>` from `AgentCredentials.tsx`.**
   - The existing `credentialOptions` builder (lines 138-148) and the
     `<Select>` at line 250 already do most of the work.
   - Factor them into a standalone component that accepts `agentId`,
     `workspaceId`, and an optional `providerFilter` prop.
   - The component fetches available credentials via
     `getAgentCredentialReference`, renders the dropdown, and calls
     `saveAgentCredentialReference` on selection.

2. **Filter credentials by provider.**
   - When the agent's execution profile specifies a provider (e.g. `anthropic`),
     only show credentials whose `provider` field matches.
   - If no provider is set yet, show all credentials grouped by provider using
     `CREDENTIAL_PROVIDERS` labels.

3. **Never expose the raw key.**
   - `SavedCredential.label` already contains a masked representation
     (see `maskCredentialLabel` in `contracts/credentials.ts`).
   - Ensure the picker always uses `label`, never the secret value.

4. **Surface the picker on every agent settings page.**
   - Coding Agent settings — already has `AgentCredentials`; swap in the new
     `<CredentialPicker>`.
   - Planning Agent settings — add the picker (currently missing).
   - Custom Agent settings — add the picker.

### Acceptance criteria

- [ ] Dropdown shows stored credentials filtered by the agent's provider.
- [ ] Selecting a credential persists the `credential_ref` via the existing
      `saveAgentCredentialReference` API.
- [ ] No raw API key is ever visible in the UI.

---

## PR 2 — Model selector uses credentials

### Goal

The model picker should only show models from providers where the user has
stored credentials, **plus** local models (Ollama / OpenAI-compatible). No
"enter API key" prompt when a credential already exists.

### Key references

| File | What it does |
|---|---|
| `contracts/credentials.ts` | `CREDENTIAL_PROVIDER_REGISTRY` maps provider to env var, label, and `launchableKind`. |
| `AgentCredentials.tsx` | `credentialProviderLabel()` already resolves human-readable provider names. |

### Changes

1. **Query available credentials on mount of the model selector.**
   - Fetch the workspace's credential list (same endpoint
     `getAgentCredentialReference` uses).
   - Build a set of `availableProviders` from the credential rows.

2. **Filter the model catalog.**
   - Cloud models: only include entries whose provider is in
     `availableProviders`.
   - Local models: always include (they do not require a stored credential).

3. **Remove the inline "enter API key" affordance** from the model picker when
   the provider already has a stored credential. Link to the credential
   settings page instead for adding new keys.

4. **Sync credential ref on model change.**
   - When the user picks a model from a different provider, auto-select the
     first matching credential (or prompt if multiple exist).

### Acceptance criteria

- [ ] Model picker only lists models from providers with stored credentials,
      plus local models.
- [ ] Changing model provider auto-selects or prompts for the matching
      credential.
- [ ] No "enter API key" field when a credential is already stored for that
      provider.

---

## PR 3 — Planning Agent UI flow

### Goal

The Planning Agent's setup page should let users pick a model + credential the
same way the Coding Agent does. No special-case UI.

### Key references

| File | What it does |
|---|---|
| `AgentCredentials.tsx` | `runnerKindForAgent()` (line 25) already maps `agentType === "planning"` to `"llm_tool_runner"`. |
| `contracts/credentials.ts` | `UpsertAgentCredentialReferenceRequestSchema` accepts `runnerKind`, `provider`, `model`, `credentialRef`. |

### Changes

1. **Add a model selector to the Planning Agent settings page.**
   - Reuse the same model selector component used by the Coding Agent.
   - Persist the selected model under `model_settings.primary`, which is written
     by `buildStoredAgentModelSettings` in `apps/api/src/supabase.ts` and read
     through `extractPrimaryModel` in `contracts/agent-helpers.ts`.
   - Persist the selection to the agent's `model_settings` column.

2. **Add the `<CredentialPicker>` (from PR 1) to the Planning Agent settings.**
   - Use `runnerKind = "llm_tool_runner"` (already handled by
     `runnerKindForAgent`).
   - The runtime will read the credential from the execution profile
     (runtime PR 1 handles that side).

3. **Unify the agent settings layout.**
   - Both Coding and Planning agents should render the same settings card
     order: Name / Context -> Model -> Credential -> Tool Policy.
   - Extract shared layout if not already shared.

### Acceptance criteria

- [ ] Planning Agent settings page has a model selector dropdown.
- [ ] Planning Agent settings page has a credential picker dropdown.
- [ ] Saving persists `model_settings.primary` and `credential_ref` to the
      agent record.
- [ ] The UI is visually consistent with Coding Agent settings.
