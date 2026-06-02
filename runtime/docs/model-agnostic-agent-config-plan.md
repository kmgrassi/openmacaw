# Model-Agnostic Agent Configuration — Runtime PRs

## Problem

The planner runner (`runner/planner.ex`) and the plan-draft endpoint
(`planner/plan_draft.ex`) are hardcoded to call OpenAI's Responses API with
`gpt-5.1`. They ignore the agent's execution profile, so even if a user
configures an Anthropic credential and model in the platform, the planner still
calls OpenAI.

The infrastructure to fix this already exists:

- `Provider.OpenAICompatible` reads model/credential from an execution profile
  and calls `/chat/completions`.
- `Provider.AnthropicMessages` reads model/credential from an execution profile
  and calls Anthropic's Messages API.
- The execution profile resolver already handles routing rules with
  model/provider/credential.
- `Runner.LocalRelay` demonstrates the correct pattern: it reads
  `target_runner_kind`, `provider`, `model`, and `credential_ref` from config.

The planner runner needs to follow the same pattern.

---

## PR 1 — Planner runner reads from execution profile

### Goal

Remove the hardcoded OpenAI path from `Runner.Planner`. The planner should
read `provider`, `model`, `base_url`, and `credential` from the resolved
execution profile, then dispatch to the appropriate provider adapter.

### Key references

| File | What it does today |
|---|---|
| `runner/planner.ex` | Hardcodes `@responses_url "https://api.openai.com/v1/responses"`, `@default_model "gpt-5.1"`. `api_key/1` only looks for `OPENAI_API_KEY`. `create_response/3` posts directly to the Responses API. Log fields hardcode `provider: "openai"`. |
| `provider/openai_compatible.ex` | Generic Chat Completions adapter. Reads `model`, `bearer_token`/`api_key`/`credential` from profile. Already used by `LocalRelay`. |
| `provider/anthropic_messages.ex` | Anthropic Messages adapter. Reads `model`, `api_key`/`credential` from profile. Has `validate_profile/1`. |
| `runner/local_relay.ex` | Reference implementation — reads `provider`, `model`, `credential_ref` from config (lines 38-48). |

### Changes

1. **Add a provider dispatch layer to `Runner.Planner`.**

   Introduce a private function that inspects the resolved profile's `provider`
   field and delegates to the correct adapter:

   ```
   provider = profile_value(config, "provider") || "openai"

   case provider do
     "openai" ->
       # Current path: OpenAI Responses API (POST /v1/responses)
       # Keeps existing request/response shape, tool format, previous_response_id
       create_openai_response(session, request, attempt)

     "anthropic" ->
       # Delegate to Provider.AnthropicMessages.start_turn/4
       # Convert planner tool specs to Anthropic tool format
       # Map response back to the runner contract

     provider when provider in ["openai_compatible", "openai-compatible", "ollama", "local"] ->
       # Delegate to Provider.OpenAICompatible.start_turn/4
       # Already handles tool specs and response normalization
       # NOTE: Both "openai_compatible" (DB constraint) and "openai-compatible"
       # (platform contracts) must be accepted. Normalize to one canonical form
       # at the top of the function.

     _ ->
       {:error, {:fatal, :unsupported_planner_provider}}
   end
   ```

2. **Read credentials from the execution profile, not env vars.**

   Replace the current `api_key/1` function:

   ```elixir
   # Current (hardcoded):
   defp api_key(config) do
     case config_value(config, "api_key") || System.get_env("OPENAI_API_KEY") do ...
   end

   # New (profile-aware):
   defp resolve_credential(config) do
     # 1. Check config for explicit api_key / credential / credential_ref
     # 2. Fall back to execution profile's resolved credential
     # 3. Fall back to provider-specific env var (OPENAI_API_KEY, ANTHROPIC_API_KEY, etc.)
   end
   ```

3. **Make log fields dynamic.**

   Replace hardcoded `provider: "openai"` in `planner_log_fields/3` and
   `planner_tool_log_fields/4` with `session.provider`.

4. **Normalize tool specs per provider.**

   - OpenAI Responses API: current `responses_tool_spec/1` format (top-level
     `type`, `name`, `description`, `parameters`).
   - Anthropic: `name`, `description`, `input_schema` (handled by
     `AnthropicMessages.normalize_tool/1`).
   - OpenAI-compatible: `{ type: "function", function: { name, description, parameters } }`
     (handled by `OpenAICompatible.normalize_tool/1`).

5. **Normalize response shape.**

   The planner's tool-calling loop (`run_responses_loop`) expects OpenAI
   Responses API output shape (`response["output"]` with `function_call` items,
   `call_id` fields). For non-OpenAI providers, map the adapter's normalized
   `turn_result` back to this shape, or refactor the loop to work with the
   normalized `turn_result` directly.

### Acceptance criteria

- [ ] Planner works with OpenAI (Responses API) when `provider: "openai"`.
- [ ] Planner works with Anthropic (Messages API) when `provider: "anthropic"`.
- [ ] Planner works with OpenAI-compatible (Chat Completions) when
      `provider: "openai_compatible"` or `"openai-compatible"` (both accepted).
- [ ] Credential is read from execution profile, not hardcoded to
      `OPENAI_API_KEY`.
- [ ] Existing OpenAI behavior is unchanged when no profile overrides are set
      (backward compatible).

---

## PR 2 — Plan draft endpoint reads from execution profile

### Goal

`POST /api/v1/plans/draft-from-prompt` (implemented in
`Planner.PlanDraft.draft_for_agent/2`) currently hardcodes OpenAI. It should
use the agent's resolved execution profile to determine provider, model, and
credential.

### Key references

| File | What it does today |
|---|---|
| `planner/plan_draft.ex` | Hardcodes `@responses_url "https://api.openai.com/v1/responses"`, `@default_model "gpt-5.1"`. `openai_api_key/1` only resolves `OPENAI_API_KEY` credentials. `response_request/2` builds an OpenAI Responses API body with `"text" => %{"format" => %{"type" => "json_schema"}}` for structured output. |

### Changes

1. **Resolve the execution profile for the agent.**

   Before making the LLM call, resolve the agent's execution profile to get
   `provider`, `model`, `base_url`, and `credential`. This is the same
   resolution path the orchestrator uses for task execution.

2. **Dispatch to provider adapters** (same pattern as PR 1).

   - OpenAI: keep the current Responses API path with native
     `json_schema` structured output.
   - Anthropic / OpenAI-compatible: use the respective adapter (see PR 3 for
     structured output handling).

3. **Replace `openai_api_key/1`** with a generic credential resolver that
   reads from the execution profile.

   Current code (lines 69-99) only looks for `OPENAI_API_KEY` in credentials
   and env. The new version should:
   - Read the credential from the resolved profile.
   - Fall back to the provider-specific env var based on the provider field.

4. **Make the model configurable.**

   `model/1` (line 175) already reads from `agent.model_settings["model"]`
   with a fallback to `@default_model`. Change the fallback to come from the
   resolved profile rather than a hardcoded `"gpt-5.1"`.

### Acceptance criteria

- [ ] `draft-from-prompt` uses the agent's execution profile for
      provider/model/credential.
- [ ] Works with OpenAI, Anthropic, and OpenAI-compatible providers.
- [ ] Backward compatible: if no profile is configured, falls back to OpenAI
      with `OPENAI_API_KEY` env var.

---

## PR 3 — Structured output fallback for non-OpenAI providers

### Goal

The plan-draft endpoint relies on OpenAI's native structured output
(`json_schema` response format in the Responses API). Other providers do not
support this. Implement a fallback strategy.

### Key references

| File | What it does today |
|---|---|
| `planner/plan_draft.ex` | `response_request/2` (line 125) sends `"text" => %{"format" => %{"type" => "json_schema", "schema" => plan_schema()}}`. `extract_draft/1` parses the response and validates against `plan_schema()`. |

### Changes

1. **OpenAI path — keep native structured output.**

   No changes needed. The current `json_schema` format directive ensures the
   response conforms to `plan_schema()`.

2. **Anthropic / OpenAI-compatible path — prompt-based JSON output.**

   - Append to the system prompt: explicit instructions to return valid JSON
     matching the plan schema. Include the schema as a reference.
   - For Anthropic: use `"prefill"` by starting the assistant turn with `{` to
     guide JSON generation.
   - For OpenAI-compatible: set `response_format: { type: "json_object" }` if
     the endpoint supports it (Ollama does for some models). Fall back to
     prompt-only if not supported.

3. **Parse and validate the response.**

   `extract_draft/1` already handles parsing JSON from raw text output (lines
   194-205). This path will be used for non-OpenAI providers. The existing
   `normalize_draft/1` and `validate_draft/1` functions handle validation.

   Add a retry-once strategy: if the first response fails JSON parsing or
   schema validation, send a follow-up message with the validation errors and
   ask the model to fix the output.

4. **Extract `plan_schema/0` to a shared module** so both the structured output
   directive (OpenAI) and the system prompt (other providers) reference the
   same schema definition.

### Acceptance criteria

- [ ] OpenAI plan drafts use native `json_schema` structured output (no
      regression).
- [ ] Anthropic plan drafts return valid JSON via prompt engineering +
      prefill.
- [ ] OpenAI-compatible plan drafts return valid JSON via prompt engineering
      (+ `response_format` where supported).
- [ ] Invalid JSON responses trigger one retry with error feedback.
- [ ] All providers' outputs pass `validate_draft/1`.
