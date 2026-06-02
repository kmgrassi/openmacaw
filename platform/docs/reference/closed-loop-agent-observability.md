# Closed-Loop Agent Observability and Coordination

## Goal

Make the platform/runtime ecosystem a closed loop: agents can observe other agents, communicate with each other, and produce enough scoped logs to diagnose failures across platform APIs, gateway WebSockets, runtime workers, LLM calls, and tool execution.

The first version should make failures understandable before making agents autonomously self-heal. A human or manager agent should be able to answer:

- Which agent failed?
- Which session, WebSocket, run, or tool call was active?
- Did the failure happen in platform auth/routing, gateway proxying, runtime orchestration, model provider calls, tool execution, or persistence?
- Which upstream model/provider/tool failed, with what retry behavior?
- Which other agents were affected or waiting on this agent?

## Principles

- **One correlation chain:** every request, WebSocket, run, model call, and tool call should carry stable correlation identifiers.
- **Hierarchical logs:** logs should preserve parent/child relationships instead of relying only on flat text search.
- **Structured first:** logs should be JSON-shaped in deployed environments and consistent across Node, Elixir, and worker processes.
- **Database only for stateful product data:** durable agent state, assignments, runs, and messages can live in the database. High-volume debug logs should go to the logging pipeline, not primary application tables.
- **Agents observe through APIs, not raw logs:** agents should consume curated health/status/event APIs. Raw logs remain for operators and deeper diagnosis.
- **Failure classification beats generic errors:** model failures, tool failures, gateway failures, auth failures, and orchestration failures should have distinct codes.

## Shared Identifiers

Every boundary should accept or create these identifiers and pass them downstream:

| Field | Meaning |
| --- | --- |
| `trace_id` | End-to-end correlation id across platform, gateway, runtime, workers, model calls, and tools. |
| `request_id` | Single HTTP request id. |
| `connection_id` | Gateway WebSocket connection id. |
| `session_key` | User-visible agent session key, for example `agent:<agent_id>:main`. |
| `workspace_id` | Tenant/workspace boundary. |
| `agent_id` | Agent being acted on. |
| `observer_agent_id` | Agent observing or supervising another agent, when applicable. |
| `run_id` | Runtime execution/run id. |
| `turn_id` | LLM turn id within a run/session. |
| `tool_call_id` | Single tool invocation id. |
| `provider_request_id` | Provider-side request id when available. |

The platform should mint `trace_id` at the first authenticated API/WebSocket boundary when the client does not send one. Runtime and workers should preserve it.

## Closed-Loop Model

### Agent Roles

| Role | Responsibility |
| --- | --- |
| User-facing agent | Executes user work and emits health/progress/tool/model events. |
| Planning/manager agent | Observes user-facing agents, coordinates tasks, detects blocked work, and can ask for remediation. |
| Coding/worker agent | Performs implementation or execution work and reports structured progress. |
| Watchdog agent | Optional future role that monitors health signals and escalates failures without owning product work. |

The first implementation does not need a new autonomous watchdog agent. It should expose enough status/event surfaces that a manager agent can be added cleanly.

### Observation Loop

1. Agent emits structured runtime events: started, heartbeat, model_call_started, model_call_failed, tool_call_started, tool_call_failed, websocket_closed, run_completed.
2. Runtime publishes summarized status to platform-facing APIs.
3. Platform dashboard and manager agents consume summarized health/status.
4. Manager agent can inspect agent status, recent events, and open failures through tools/APIs.
5. Manager agent can trigger a remediation action: retry, restart, reconfigure credentials, ask user for input, or create follow-up work.

### Communication Loop

Agents should communicate through explicit channels rather than ad hoc database writes:

- **Control messages:** platform/runtime APIs for start, stop, restart, assign, retry, cancel.
- **Work messages:** task/work-item updates and agent-to-agent handoff notes.
- **Session messages:** user-visible chat/session messages.
- **Observability events:** structured events for logs and status summaries.

Do not make raw logs the agent communication layer. Logs are evidence; APIs and event summaries are the communication contract.

## Logging Architecture

### Layers

| Layer | Examples | Logging Responsibility |
| --- | --- | --- |
| Browser | Dashboard, onboarding, chat UI | Client request ids, WebSocket connection lifecycle, user-visible error codes. |
| Platform API | Auth, setup, gateway proxy, agent config | Request logs, auth decisions, launcher calls, runtime routing, upstream status codes. |
| Gateway/WebSocket | `/ws`, runtime proxy, protocol negotiation | Connection open/close, protocol version, close codes, upstream/downstream errors. |
| Runtime launcher | Agent start/stop, engine_instance writes, supervision | Agent lifecycle, process ports, DB sync, restart attempts. |
| Runtime orchestrator | Agent session, model loop, tools | Run/turn/tool hierarchy, model provider calls, tool call results. |
| Worker/tool process | Codex/Claude/local tools, filesystem, git | Tool input metadata, exit status, duration, retryable classification. |
| AWS | ECS, ALB, CloudWatch, Secrets, networking | Container health, service deployment, task restarts, load balancer health, secret lookup failures. |

### Log Shape

Use structured logs with stable keys:

```json
{
  "level": "error",
  "event": "model_call_failed",
  "trace_id": "trc_...",
  "workspace_id": "...",
  "agent_id": "...",
  "session_key": "agent:...:main",
  "run_id": "run_...",
  "turn_id": "turn_...",
  "provider": "openai",
  "model": "openai/gpt-5.2",
  "provider_request_id": "req_...",
  "error_code": "provider_rate_limited",
  "retryable": true,
  "duration_ms": 1832
}
```

Avoid logging secrets, raw API keys, bearer tokens, or full prompt content by default. Prompt/tool payload capture should be opt-in, redacted, and environment-gated.

### Event Names

Initial common event vocabulary:

- `request_started`, `request_completed`, `request_failed`
- `auth_token_validated`, `auth_token_rejected`
- `launcher_call_started`, `launcher_call_completed`, `launcher_call_failed`
- `agent_start_requested`, `agent_started`, `agent_start_failed`
- `agent_stop_requested`, `agent_stopped`, `agent_stop_failed`
- `engine_instance_upsert_failed`, `engine_instance_heartbeat_failed`
- `gateway_ws_opened`, `gateway_ws_closed`, `gateway_ws_upstream_failed`
- `run_started`, `run_completed`, `run_failed`
- `turn_started`, `turn_completed`, `turn_failed`
- `model_call_started`, `model_call_completed`, `model_call_failed`
- `tool_call_started`, `tool_call_completed`, `tool_call_failed`
- `manager_observation_started`, `manager_observation_completed`, `manager_remediation_requested`

## LLM and Tool Failure Visibility

This is the highest-priority observability gap.

For each model call, log:

- provider, model, credential scope, and credential id/hash suffix, never the key
- turn/run/session identifiers
- request start/end timestamps and duration
- token counts when available
- streaming state: stream opened, first token latency, stream closed, stream errored
- provider status code and provider request id when available
- normalized error code: `provider_auth_failed`, `provider_rate_limited`, `provider_timeout`, `provider_overloaded`, `provider_invalid_request`, `provider_stream_interrupted`, `provider_unknown`
- retry count and backoff decision

For each tool call, log:

- tool name and version
- allow/deny decision and policy source
- sanitized input summary
- start/end timestamps and duration
- exit status or tool-specific result status
- normalized error code: `tool_denied`, `tool_timeout`, `tool_process_failed`, `tool_invalid_args`, `tool_dependency_missing`, `tool_unknown`
- parent `turn_id` and `run_id`

## AWS Observability

Minimum AWS-side shape:

- CloudWatch log groups per service: platform API, gateway if separate, runtime launcher, runtime orchestrator, workers.
- ECS task/container metadata included in each log: service name, task arn suffix, container name, deployment id.
- ALB access logs or equivalent request logs for API/gateway ingress.
- CloudWatch metric filters for high-value events:
  - model call failures
  - tool call failures
  - WebSocket abnormal closes
  - launcher unreachable
  - engine_instance write failures
  - task restarts
- Alarms routed to an operator channel initially; later to manager/watchdog agent inputs.

OpenTelemetry should be considered for traces, but the first PRs can start with consistent JSON logs and correlation ids.

## Agent-Facing Monitoring APIs

Agents should not scrape CloudWatch. Add curated APIs/tools:

- `GET /api/agents/:agentId/health`
  - current gateway/runtime/config status
  - last heartbeat
  - last model/tool failure summary
- `GET /api/agents/:agentId/events?limit=...`
  - recent summarized events, not raw logs
- `POST /api/agents/:agentId/remediations`
  - retry, restart, stop, request_credentials, request_user_input
- Runtime tool: `agent.observe`
  - lets a manager agent inspect another agent's summarized state
- Runtime tool: `agent.message`
  - sends a structured agent-to-agent message or handoff note

These APIs can initially be backed by in-memory or recent runtime state plus platform status queries. Durable event storage can be added later if needed.

## Suggested PR Sequence

### PR1: Correlation IDs and Structured Platform Logs

Target repo: `parallel-agent-platform`.

- Add request/trace id middleware in platform API.
- Include trace ids in launcher calls and WebSocket upgrade handling.
- Normalize platform event names and JSON log shape.
- Redact auth headers and tokens.

### PR2: Runtime Structured Logs and Event Vocabulary

Target repo: `parallel-agent-runtime`.

- Add shared runtime logger helpers.
- Emit lifecycle events for launcher, orchestrator, WebSocket, run, turn, model call, and tool call boundaries.
- Preserve platform `trace_id` downstream.

### PR3: Model Call and Tool Call Failure Classification

Target repo: `parallel-agent-runtime`.

- Normalize provider errors into stable error codes.
- Normalize tool errors into stable error codes.
- Log retryability, attempts, duration, and provider request ids.

### PR4: Agent Health Summary API

Target repo: `parallel-agent-platform`, with runtime response-shape support in `parallel-agent-runtime` if the current launcher APIs do not expose the needed fields.

- Add platform endpoint for current agent health.
- Include config state, launcher reachability, runtime state, last heartbeat, and last known failure summary.
- Update dashboard details to show the source layer of failures.

### PR5: Agent-to-Agent Observation Tools

Target repo: both. Runtime owns the `agent.observe` tool implementation; platform owns the authenticated health/events API and access checks it calls.

- Add runtime/platform tools for manager agents to inspect another agent.
- Enforce workspace membership and agent access policy.
- Return summarized health/events, not raw logs.

### PR6: Agent-to-Agent Messaging and Remediation

Target repo: both. Runtime owns agent-to-agent tool execution and remediation dispatch; platform owns durable/control-plane APIs for allowed remediation actions.

- Add structured handoff/control messages.
- Add remediation actions: retry, restart, request credentials, request user input.
- Log all remediation requests with observer and target agent ids.

### PR7: AWS Logging and Alarms

Target repo: both. Platform owns API/gateway infrastructure logging; runtime owns launcher/orchestrator/worker service logging and runtime alarms.

- Standardize CloudWatch log group names and retention.
- Add metric filters and alarms for model/tool/gateway/runtime failures.
- Include ECS/container metadata in service logs.

## Open Questions

Current decisions:

- Do not add an `agent_event` table yet. Keep high-volume events in structured logs and expose summarized recent status through APIs.
- Manager agents should have read access to all agents/workspaces within the same customer boundary by default. They are customer-scoped, not global.
- Prompt, tool, and secret visibility can be available to the customer-scoped manager agent. We should still avoid accidental public/global leakage, but we do not need to hide this information from that customer's manager agent.
- Keep `trace_id`, `turn_id`, `run_id`, and `tool_call_id` on the server side by default. The frontend only needs user-facing error/status ids unless we later add an operator/debug view.
- Use third-party model provider APIs for traces/tool-call chains where available instead of duplicating full trace storage ourselves. This will be provider-specific and less complete for open-source/local models, so our logs still need enough correlation metadata to join local events with provider traces.
- Do not introduce OpenTelemetry or a new observability platform yet. Start with our own structured logs, event vocabulary, health APIs, and AWS log plumbing.

Clarification on remediation autonomy:

- "Autonomous remediation" means an agent can take a recovery action without a human click, for example retrying a failed model call, restarting a worker, reapplying gateway config, or asking another agent to continue the task.
- Default toward no human interaction. The manager agent should decide when remediation can proceed directly and when the situation needs to be elevated to the user.
- First pass should support autonomous retries, health/config refreshes, worker restarts, and agent-to-agent handoffs, with clear logs for what the manager chose and why.
- Over time, pass policy/context into the manager agent describing when to elevate to the user, such as destructive workspace changes, credential replacement, cost spikes, repeated failed remediation, or ambiguous product intent.
- User escalation should be a structured remediation outcome, not the default control path.

Remaining open questions:

- What exact customer boundary should manager-agent read access use: customer/account, workspace group, or all workspaces owned by the same user?
- Which provider trace APIs should we support first, and what identifiers must we log to retrieve those traces later?
- What is the minimum local trace summary needed when provider trace APIs are unavailable?
- Should the frontend expose trace ids only in a debug/details panel for support, while keeping normal user flows clean?

## First Milestone

The first milestone is not full autonomy. It is diagnosability:

1. A failed chat/model/tool interaction can be traced from browser to platform API to gateway to runtime to provider/tool.
2. The dashboard can show which layer is failing.
3. A manager agent can inspect another agent's current health summary.
4. Logs expose provider/model/tool failure classification without exposing secrets.
