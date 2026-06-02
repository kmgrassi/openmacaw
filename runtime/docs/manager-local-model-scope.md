# Manager Local Model Scope

## Goal

Allow the workspace manager agent to run against a locally hosted model while
keeping the manager scheduler, due-task input shape, and manager tool contract
intact.

The MVP target is an OpenAI-compatible local endpoint, such as Ollama,
LM Studio, vLLM, or a local runtime helper that exposes an OpenAI-compatible
model interface.

## Current State

The manager execution path is currently OpenAI Responses API specific:

- `Manager.SessionResolver` accepts only `openai` / `openai_responses`
  providers.
- `Runner.Manager` posts to `https://api.openai.com/v1/responses` by default.
- manager credential resolution expects an OpenAI-style API key.
- platform manager activation allows many hosted providers, but runtime rejects
  non-OpenAI manager providers.

There is a `base_url` override in `Runner.Manager`, so a server that fully
implements the OpenAI Responses API might work. Most local model servers,
however, implement `/v1/chat/completions`, not `/v1/responses`.

The runtime already has local model infrastructure for regular agent execution:

- `Runner.LocalRelay`
- local relay websocket registration and dispatch
- OpenAI-compatible provider support
- local model capability registration
- `local_model_coding` / `local_relay` execution profile concepts

The manager path does not currently use that infrastructure.

## Design Principle

The manager should remain a manager-specific runner because it has a
manager-specific prompt, tool set, due-task input shape, and scheduler lifecycle.

The model transport inside the manager runner should become pluggable. The
manager should not require a different scheduler or a different tool contract
just because the model backend is local.

## Target Architecture

```text
Manager.Scheduler
  -> due_query(work_items where next_poll_at <= now)
  -> Manager.run_batch(session, due_items)
  -> Runner.Manager
      -> Manager.ModelClient.OpenAIResponses
      -> Manager.ModelClient.OpenAICompatibleChat
      -> future Manager.ModelClient.LocalRelay
```

The scheduler still passes:

```json
{"due_tasks":[...]}
```

The manager model client is responsible for translating the manager prompt,
tools, and follow-up tool outputs to the backend's protocol.

## Proposed Runtime Design

### 1. Split manager model transport from manager orchestration

Introduce a small manager model-client behavior.

```elixir
@callback create_response(session :: map(), request :: map(), attempt :: pos_integer())
          :: {:ok, response :: map()} | {:error, term()}

@callback initial_request(session :: map(), due_tasks_payload :: String.t(), work_item :: WorkItem.t())
          :: map()

@callback follow_up_request(session :: map(), response :: map(), tool_outputs :: [map()])
          :: map()

@callback output_texts(response :: map()) :: [String.t()]

@callback tool_calls(response :: map()) :: [map()]

@callback response_id(response :: map()) :: String.t() | nil
```

Keep `Runner.Manager` responsible for:

- manager prompt loading
- due-task input semantics
- max tool-iteration loop
- manager tool execution
- normalized events
- usage/result normalization

Move provider-specific request/response parsing into model clients.

### 2. Keep OpenAI Responses as the default client

The existing behavior should become `Manager.ModelClient.OpenAIResponses`.

Configuration:

```json
{
  "provider": "openai",
  "model": "openai/gpt-5.2",
  "base_url": "https://api.openai.com/v1/responses",
  "credential_id": "..."
}
```

This preserves current hosted-manager behavior.

### 3. Add OpenAI-compatible chat completions for local models

Add `Manager.ModelClient.OpenAICompatibleChat` for local endpoints that expose:

```text
POST /v1/chat/completions
```

Configuration:

```json
{
  "provider": "openai_compatible",
  "model": "qwen3-coder:30b",
  "base_url": "http://127.0.0.1:11434/v1",
  "api_key": "local-dev-key",
  "tool_calling": "native"
}
```

The client should:

- convert manager instructions into a `system` message
- convert due-task JSON into a `user` message
- send manager tools in OpenAI-compatible chat-completions format
- parse `choices[0].message.content` as assistant text
- parse `choices[0].message.tool_calls` as manager tool calls
- send tool outputs as `role: tool` messages on follow-up turns

For local servers without native tool calling, add a follow-up mode later:

```json
{"tool_calling": "prompt_json"}
```

The MVP should prefer native tool calling and fail clearly when the endpoint
does not return supported tool-call shapes.

### 4. Credential handling for local endpoints

Local endpoints often do not require a real API key. The runtime still needs a
uniform auth field so request code can build headers consistently.

Recommended behavior:

- allow `api_key` in manager gateway config for local development
- allow `credential_id` / `credential_alias` for stored local endpoint secrets
- if provider is `openai_compatible` and no key is supplied, use a harmless
  placeholder such as `local-runtime`
- never require an OpenAI credential for `openai_compatible`

This avoids blocking local-manager execution on hosted-provider credential
rules.

### 5. Provider validation

Update `Manager.SessionResolver` to accept:

- `openai`
- `openai_responses`
- `openai_compatible`
- `local`

Normalize provider/config into a concrete model client:

| Provider | Client | Endpoint style |
|---|---|---|
| `openai` | `OpenAIResponses` | `/v1/responses` |
| `openai_responses` | `OpenAIResponses` | `/v1/responses` |
| `openai_compatible` | `OpenAICompatibleChat` | `/v1/chat/completions` |
| `local` | `OpenAICompatibleChat` initially | `/v1/chat/completions` |

Later, `local` can route through `Runner.LocalRelay` if the manager should use
the helper websocket instead of directly calling localhost from the runtime.

### 6. Platform manager activation alignment

The platform currently lets users choose providers the runtime manager does not
support. That should be corrected as part of this feature.

For the first local-manager implementation:

- expose `OpenAI` and `OpenAI-compatible local` in the manager settings UI
- for local provider, show `base_url` and model fields
- do not require selecting a hosted credential for local endpoints
- persist `provider`, `model`, `base_url`, and credential/api-key mode into
  `runners.manager`

Hosted non-OpenAI providers should remain hidden or disabled for manager
activation until runtime clients exist for them.

## Implementation Plan

### PR 1: Runtime manager model-client abstraction

Files likely touched:

- `apps/orchestrator/lib/symphony_elixir/runner/manager.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/session_resolver.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/model_client/openai_responses.ex`
- `apps/orchestrator/lib/symphony_elixir/manager/model_client/openai_compatible_chat.ex`
- `apps/orchestrator/test/symphony_elixir/runner/manager_test.exs`
- `apps/orchestrator/test/symphony_elixir/manager/session_resolver_test.exs`

Expected changes:

- extract existing Responses API request/response logic into a client module
- preserve current OpenAI manager behavior
- add OpenAI-compatible chat-completions client
- add tests for local provider config resolving without OpenAI credential
- add tests for native tool-call parsing and follow-up tool output messages

### PR 2: Platform local manager configuration

Files likely touched in `parallel-agent-platform`:

- `contracts/manager-agent.ts`
- `apps/api/src/routes/manager-agent.ts`
- `apps/web/src/components/settings/ManagerAgentSection.tsx`
- manager activation tests

Expected changes:

- allow manager activation payloads to include `baseUrl`
- add provider option for local OpenAI-compatible manager
- persist local manager config into `runners.manager`
- avoid requiring hosted credentials for local manager configs
- hide or disable unsupported hosted providers for manager execution

### PR 3: Optional local relay manager backend

This is not required for direct localhost MVP.

Use this if the runtime should avoid calling a developer's localhost endpoint
directly, or if the local model must run behind `local-runtime-helper`.

Expected direction:

- add `Manager.ModelClient.LocalRelay`
- dispatch a manager request over the existing local relay websocket
- require helper capability `manager_tool_calling` or equivalent
- reuse the same manager model-client behavior

## Acceptance Criteria

- Existing OpenAI manager configuration still calls the Responses API and passes
  current tests.
- A manager config with provider `openai_compatible`, model, and local
  `base_url` can start a runnable manager session without an OpenAI credential.
- The manager sends due-task JSON to the local endpoint as a chat-completions
  user message.
- Native local model tool calls are executed through existing manager tools.
- Manager assistant output and usage are normalized into the existing
  `Runner.Manager` result shape.
- Unsupported local tool-call formats fail with a typed, actionable error.
- Platform manager settings no longer imply that unsupported hosted providers
  are runnable by the manager.

## Non-Goals

- supporting every hosted provider in the manager
- requiring local relay for the MVP
- changing manager scheduling cadence or due-item selection
- changing manager tool semantics
- adding new database tables
- guaranteeing that all local models are good at tool calling

## Risks

- Many local models have weak or nonstandard tool-call behavior. The feature
  should detect unsupported output and fail clearly instead of pretending the
  turn succeeded.
- Direct runtime-to-localhost calls only work when runtime and model server run
  on the same machine. Remote deployments need the local relay client path.
- OpenAI-compatible servers vary in how they report usage. Usage metadata should
  be optional.
- Long-running local model requests can exceed the manager cadence. The
  scheduler should avoid overlapping manager turns for the same workspace before
  this is enabled broadly.

## Open Questions

1. Should the first local manager MVP call `base_url` directly, or should it
   require `local-runtime-helper` from day one?
2. Should `provider: local` mean "direct OpenAI-compatible endpoint" or
   "dispatch through local relay"?
3. Which local model should be the reference smoke target?
4. Should manager activation allow no API key for local endpoints, or should the
   UI require a placeholder/stored credential for audit consistency?
