# Agent Configuration Error UX — Runtime Scoping Document

## Problem

When the launcher rejects an agent start request due to invalid or missing configuration, the error responses are human-readable strings but not machine-parseable. The platform receives errors like:

```json
{ "error": "agent launch config tracker.kind is required" }
```

or:

```json
{ "error": "{:invalid_agent_config, \"agent launch config tracker.kind is required\"}" }
```

The platform cannot reliably parse these into user-facing guidance because:
1. Error messages are free-form strings, not structured codes
2. The `format_error/1` function in `router.ex` stringifies tuples like `{:invalid_agent_config, msg}` using `inspect/1`
3. There is no machine-readable indication of *which* config fields are missing or *how* to fix them
4. The platform must resort to string matching to distinguish error types

Meanwhile, the platform has its own execution profile resolution that determines credentials, model, and routing — but the launcher independently validates config (e.g., `tracker.kind` presence) without knowledge of the platform's resolution. When these two validation paths disagree, the user gets confusing errors.

## Goal

1. Return structured, machine-readable error responses from the launcher so the platform can translate them into actionable user-facing messages
2. Forward the platform's resolved execution profile to the launcher so both systems use the same resolution

## Current Flow

### Agent start path (`POST /agents/:id/start`)

1. Platform calls `POST /api/agents/:id/start` on the API server
2. API server calls `assertRuntimePrepareSupported()` which runs `resolveExecutionProfile()` — checks agent exists, model/runner/credential/routing rule are present
3. If the execution profile resolves, API server forwards to launcher: `POST /agents/:id/start` on port 4100
4. Launcher's `Router` dispatches to `Server.start_agent/2` (router.ex line 223)
5. `Server.start_agent/2` calls `AgentInventory.get_agent/1`, then `PlanHandoff.validate_launch/2`
6. If agent found and not already running, calls `start_new_agent_orchestrator/3`
7. `resolve_and_validate_agent_config/1` (server.ex line 790):
   - Fetches gateway_config from Supabase (`resolve_launch_config/1`)
   - Injects stored agent data (`inject_stored_agent/2`)
   - Injects stored credentials (`inject_stored_credentials/2`)
   - Normalizes execution profile (`normalize_execution_profile/1`)
   - **Validates `tracker.kind` is present** — this is where the 422 often originates
8. On validation failure, returns `{:error, {:invalid_agent_config, message}}`
9. Router formats this as `json_resp(conn, 422, %{error: format_error(reason)})`

### Error formatting (`format_error/1` in router.ex)

```elixir
defp format_error(reason) when is_binary(reason), do: reason
defp format_error(reason) when is_atom(reason), do: Atom.to_string(reason)
defp format_error({:invalid_agent_config, message}) when is_binary(message), do: message
defp format_error(reason), do: inspect(reason)
```

This handles `{:invalid_agent_config, msg}` specifically but all other error tuples fall through to `inspect/1`, producing strings like `"{:some_error, \"details\"}"` that the platform cannot parse.

## PR Plan

### PR1: Structured launcher rejection responses

**Files:**
- `apps/orchestrator/lib/symphony_elixir/launcher/router.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/server.ex`

**What changes:**

#### Router changes (router.ex)

Replace the free-form error string in 422 responses with a structured JSON body. The `POST /agents/:id/start` handler at line 223 currently does:

```elixir
{:error, {:invalid_agent_config, _} = reason} ->
  json_resp(conn, 422, %{error: format_error(reason)})

{:error, reason} ->
  json_resp(conn, 422, %{error: format_error(reason)})
```

Change to return structured errors:

```elixir
{:error, {:invalid_agent_config, message, details}} ->
  json_resp(conn, 422, %{
    error: message,
    error_code: Map.get(details, :error_code, "invalid_agent_config"),
    required_config: Map.get(details, :required_config, []),
    resolution_hint: Map.get(details, :resolution_hint)
  })

{:error, {:invalid_agent_config, message}} ->
  json_resp(conn, 422, %{
    error: message,
    error_code: "invalid_agent_config",
    required_config: [],
    resolution_hint: nil
  })
```

This is backward-compatible: the `error` field still contains the human-readable message. The new fields (`error_code`, `required_config`, `resolution_hint`) are additive.

#### Server changes (server.ex)

Update `resolve_and_validate_agent_config/1` (line 790) to return structured error details instead of bare strings. Currently:

```elixir
case get_in(merged, ["tracker", "kind"]) do
  kind when is_binary(kind) and kind != "" ->
    {:ok, merged, resolution}

  _ ->
    {:error, {:invalid_agent_config, "agent launch config tracker.kind is required"}}
end
```

Change to include machine-readable details:

```elixir
_ ->
  {:error, {:invalid_agent_config, "agent launch config tracker.kind is required", %{
    error_code: "missing_tracker_kind",
    required_config: ["tracker.kind"],
    resolution_hint: "Create a gateway_config with tracker settings for this agent"
  }}}
```

Similarly, for `normalize_execution_profile/1` failures (line 809), include structured details about what the execution profile normalization rejected.

**Error code catalog:**

Define a set of known error codes that the platform can map to user-facing messages:

| Error Code | Meaning | Required Config | Resolution Hint |
|---|---|---|---|
| `missing_tracker_kind` | No tracker.kind in launch config | `["tracker.kind"]` | Create a gateway_config with tracker settings |
| `invalid_execution_profile` | Execution profile failed normalization | varies | Check model/provider/runner settings |
| `gateway_config_not_found` | No gateway_config row for agent or workspace | `["gateway_config"]` | Create a gateway_config entry in Supabase |
| `agent_not_found` | Agent ID not in inventory | `["agent"]` | Agent must exist in the agent table |
| `credential_resolution_failed` | Could not resolve stored credentials | `["credentials"]` | Add credentials for this agent |

#### Pattern for the `format_error/1` update

Add a new clause to handle the 3-tuple:

```elixir
defp format_error({:invalid_agent_config, message, _details}) when is_binary(message), do: message
```

This keeps the existing `format_error/1` behavior for contexts that only need a string (e.g., logging), while the router can pattern-match on the full tuple to extract structured details.

### PR2: Forward execution profile to launcher

**Files:**
- `apps/orchestrator/lib/symphony_elixir/launcher/server.ex`
- `apps/orchestrator/lib/symphony_elixir/launcher/router.ex`

**What changes:**

#### Problem

The platform resolves the execution profile (model, provider, credentials, runner kind) via `resolveExecutionProfile()` in the API server. The launcher independently resolves its own version by reading gateway_config from Supabase and running `ExecutionProfile.normalize_from_config/1`. These two resolutions can diverge:

- The platform may resolve via a routing rule; the launcher reads gateway_config directly
- The platform may have a credential from the routing rule; the launcher reads stored credentials from the credential table
- If Supabase is slow/unavailable at launcher start time, the launcher may fail while the platform succeeded moments earlier

#### Approach

When the platform sends `POST /agents/:id/start` to the launcher, include the already-resolved execution profile in the request body:

```json
{
  "trace_id": "...",
  "resolved_execution_profile": {
    "agentId": "...",
    "workspaceId": "...",
    "role": "coding",
    "runnerKind": "codex",
    "provider": "openai",
    "model": "gpt-5.2",
    "credentialRef": { "type": "credential_id", "value": "..." },
    "toolProfile": "coding",
    "capabilities": { ... }
  }
}
```

The launcher's `start_agent/2` handler (router.ex line 223) already passes `conn.body_params` as `launch_params`. The `start_new_agent_orchestrator/3` function should check for `resolved_execution_profile` in the launch params and, if present, use it instead of running its own resolution.

#### Server changes

In `resolve_and_validate_agent_config/1` (server.ex line 790), before fetching gateway_config:

```elixir
defp resolve_and_validate_agent_config(%Agent{} = agent, launch_params \\ %{}) do
  case Map.get(launch_params, "resolved_execution_profile") do
    %{} = profile when map_size(profile) > 0 ->
      # Platform already resolved — use it, just validate tracker.kind
      ...

    _ ->
      # Legacy path: resolve from gateway_config
      ...
  end
end
```

This needs a signature change: `start_new_agent_orchestrator/3` must pass launch_params through to `resolve_and_validate_agent_config/2`.

#### Platform side (parallel-agent-platform)

The platform's `POST /api/agents/:id/start` handler in `proxy.ts` (line 322) calls `assertRuntimePrepareSupported()` which already resolves the execution profile. The profile should be forwarded to the launcher's start request via `launcherClient.startAgent(agentId, { resolved_execution_profile: profile })`.

This platform-side change is documented here for context but would be implemented in the platform repo.

## Sequencing

1. **PR1** first — structured error responses. This is purely additive (new fields alongside existing `error` string) and does not require platform changes to work. The platform can start consuming the new fields incrementally.
2. **PR2** second — execution profile forwarding. This requires coordination with the platform repo to actually send the profile. The launcher should accept but not require it (fallback to existing resolution if not present).

## Testing

### PR1 testing

```bash
# Start runtime
npm run start:local

# Test missing tracker.kind using an existing inventory agent whose gateway_config
# is present but does not include tracker.kind. A nonexistent agent returns 404
# before launcher config validation runs.
AGENT_ID=<existing-agent-id-with-missing-tracker-kind>
curl -X POST "http://127.0.0.1:4100/agents/${AGENT_ID}/start" \
  -H "Content-Type: application/json" \
  -d '{}'

# Existing tests
cd apps/orchestrator && mix test
```

Verify:
- Existing tests still pass (format_error/1 backward compatibility)
- 422 responses include `error_code`, `required_config`, `resolution_hint` fields
- The `error` field still contains the human-readable message

### PR2 testing

```bash
# Test with resolved_execution_profile in body
curl -X POST http://127.0.0.1:4100/agents/<agent-id>/start \
  -H "Content-Type: application/json" \
  -d '{"resolved_execution_profile": {"runnerKind": "codex", "provider": "openai", "model": "gpt-5.2"}}'
```

Verify:
- Launcher uses the forwarded profile when present
- Launcher falls back to gateway_config resolution when profile is absent
- Full stack test: platform sends profile, launcher uses it, agent starts

## Out of Scope

- Changing the execution profile normalization logic in `ExecutionProfile.normalize_from_config/1`
- Modifying orchestrator behavior after start (this is about the start path only)
- Frontend changes (those are in the platform repo's scoping doc)
- Gateway config CRUD (the runtime reads gateway_config, it does not manage it)
