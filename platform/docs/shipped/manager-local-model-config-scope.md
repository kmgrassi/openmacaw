# Manager Local Model Configuration Scope

## Goal

Let Platform configure the manager agent to use a locally hosted
OpenAI-compatible model once runtime supports local manager execution.

Runtime companion scope:

- `parallel-agent-runtime` PR #215:
  `docs/manager-local-model-scope.md`

The Platform work should align the Manager Agent settings UI, API contract, and
gateway config persistence with the runtime model-client design.

## Current State

The Manager Agent settings UI currently presents hosted credential providers and
stores manager configuration into `gateway_config.config_json.runners.manager`.

Relevant files:

- `contracts/manager-agent.ts`
- `contracts/credentials.ts`
- `apps/api/src/routes/manager-agent.ts`
- `apps/api/src/services/manager-runtime-status.ts`
- `apps/web/src/components/settings/ManagerAgentSection.tsx`
- `apps/web/src/api/manager-agent.ts`
- local model settings under `apps/web/src/components/settings/LocalModelsSection.tsx`

Runtime currently only runs the manager through OpenAI Responses API, even
though the UI exposes multiple hosted providers. That mismatch should be fixed
while adding local model configuration.

## Design Principle

Manager model configuration should describe what runtime can actually execute.

Do not expose hosted providers as runnable manager backends until runtime has a
manager model client for them. For the first local-manager pass, Platform should
support:

- OpenAI Responses manager
- local/OpenAI-compatible chat-completions manager

## Proposed Platform Design

### 1. Extend the manager activation contract

`ManagerCredentialActivationRequestSchema` should support local manager config.

Candidate shape:

```ts
{
  workspaceId: string;
  agentId: string;
  provider: "openai" | "openai_compatible" | "local";
  model: string;
  runnerKind: "llm_tool_runner";
  baseUrl?: string;
  credentialRef?: CredentialReference;
  newCredential?: {
    apiKey: string;
    label?: string;
  };
  cadenceMs?: number;
}
```

Validation rules:

- OpenAI requires `credentialRef` or `newCredential`.
- Local/OpenAI-compatible may accept no credential.
- Local/OpenAI-compatible requires `baseUrl`.
- `baseUrl` must be an HTTP(S) URL. Local development may use
  `http://127.0.0.1:11434/v1` or `http://localhost:11434/v1`.

### 2. Persist local manager config into gateway config

`managerRunnerConfig` should preserve and write:

```json
{
  "runners": {
    "manager": {
      "kind": "manager",
      "agent_id": "...",
      "provider": "openai_compatible",
      "model": "qwen3-coder:30b",
      "base_url": "http://127.0.0.1:11434/v1",
      "min_cadence_ms": 60000
    }
  }
}
```

For OpenAI manager config, preserve the existing credential behavior.

For local manager config, avoid writing stale `credential_id` or
`credential_alias` values unless the user explicitly selected a local endpoint
credential.

### 3. Update Manager Agent settings UI

The UI should offer a manager-specific provider list, not the full generic
credential provider registry.

Recommended options for MVP:

- OpenAI
- Local OpenAI-compatible

For Local OpenAI-compatible:

- show `Base URL`
- show `Model`
- show `Cadence`
- hide hosted workspace credential selector by default
- optionally show an advanced API key field for local servers that require one
- include examples in placeholders, not large explanatory text

For OpenAI:

- keep existing credential reuse/new-key flow
- keep model and cadence fields

### 4. Align local models with existing Local Models settings

If a local model has already been registered in the Local Models section,
Manager Agent settings should eventually let the user select it instead of
typing `baseUrl` and `model`.

MVP can be manual `baseUrl` + `model`.

Follow-up:

- list registered local models with manager-compatible capabilities
- prefill `baseUrl`, provider, and model from the selected local model
- warn if the model lacks native tool-call capability

### 5. Status and validation feedback

Manager runtime status should surface local configuration errors clearly.

Expected status/error cases:

- local endpoint unreachable
- local endpoint does not support native tool calls
- model missing on local endpoint
- request timeout
- local manager config missing `base_url`

Platform should display these in the existing Manager Agent status card without
adding a separate diagnostics surface in the first pass.

## Implementation Plan

### PR 1: Contract/API support for local manager config

Likely files:

- `contracts/manager-agent.ts`
- `apps/api/src/routes/manager-agent.ts`
- `apps/api/src/services/setup/builders.ts` if manager config builders are
  centralized there
- manager activation tests

Expected changes:

- add `baseUrl` to manager activation payload
- allow local/OpenAI-compatible providers in manager activation
- make credentials optional for local manager providers
- persist `base_url` and clear stale hosted credential refs when appropriate
- keep OpenAI activation behavior unchanged

### PR 2: Manager settings UI for local provider

Likely files:

- `apps/web/src/components/settings/ManagerAgentSection.tsx`
- `apps/web/src/api/manager-agent.ts`
- UI tests if present

Expected changes:

- use manager-specific provider options
- show local `Base URL` field
- hide hosted credential controls for local unless advanced key mode is enabled
- submit local manager activation payload
- render local manager status/errors clearly

### PR 3: Registered local model picker follow-up

Likely files:

- `apps/web/src/components/settings/ManagerAgentSection.tsx`
- `apps/web/src/api/local-runtime.ts`
- local model capability helpers

Expected changes:

- list registered local models
- allow selecting a local model for manager use
- warn when the selected model lacks required tool-call capability

## Acceptance Criteria

- Platform can save an OpenAI manager config exactly as before.
- Platform can save a local/OpenAI-compatible manager config with provider,
  model, `base_url`, cadence, and no hosted credential.
- Gateway config does not retain stale OpenAI credential refs when switching the
  manager to local.
- Manager Agent settings only shows providers supported by runtime manager
  execution.
- Local endpoint validation errors from runtime are visible in the Manager Agent
  status UI.
- Existing Local Models settings remain unchanged unless the optional picker
  follow-up is implemented.

## Non-Goals

- implementing runtime local manager execution
- building local relay manager transport in Platform
- adding a new local runtime database schema
- supporting every hosted provider as a manager backend
- proving every local model can use tools reliably

## Open Questions

1. Should local manager config be manual `baseUrl` first, or require selecting a
   registered local model?
2. Should Platform allow `provider: "local"` or only
   `provider: "openai_compatible"` for the first pass?
3. Should local manager API keys be stored in the same credential table, or
   should no-key local endpoints be the default?
4. Should unsupported hosted manager providers be hidden, disabled, or shown
   with "runtime support pending" copy?
