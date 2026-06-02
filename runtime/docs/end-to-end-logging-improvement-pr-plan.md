# End-to-End Logging Improvement PR Plan

Source: `parallel-agent-platform` PR 321,
`docs/end-to-end-logging-pr-plan.md`.

## Goal

Improve logs across the full runtime/platform stack so a failed user request can be traced from browser or platform API entry, through launcher and runtime routing, into database writes, model calls, tool execution, and final agent-visible state.

This plan is intentionally split into parallel PRs. Each PR should be independently reviewable and should preserve the existing rule that high-volume debug data stays out of product tables unless it is durable product state.

## Mapping From Platform PR 321

The platform plan's runtime-owned work maps into this repo as follows:

| Platform PR 321 slice | Runtime repo slice |
| --- | --- |
| PR7: Runtime Launcher and Orchestrator Event Vocabulary | PR4, PR5, PR6, and PR7 in this document cover runtime log helpers, gateway boundary logs, launcher lifecycle logs, and manager scheduler logs. |
| PR8: Model Provider and Tool Execution Logs | PR8 and PR9 split the work into model-provider call logs and tool/shell execution logs so separate agents can implement them in parallel. |
| PR10: Operational Formatting, Dashboards, and Alerts | PR11 covers production log pipeline, metric filters, alerts, dashboards, and runbook/query examples for runtime-owned services. |

## Shared Logging Contract

Every PR should converge on the same baseline fields where applicable:

| Field | Purpose |
| --- | --- |
| `event` | Stable event name, for example `postgrest_request_failed` or `tool_call_completed`. |
| `trace_id` | End-to-end correlation id across platform, launcher, runtime, workers, database calls, models, and tools. |
| `request_id` | Single HTTP request id when inside an API request. |
| `connection_id` | Gateway or relay WebSocket connection id. |
| `workspace_id` | Tenant/workspace scope. |
| `agent_id` | Agent being acted on. |
| `session_key` | Logical session key, for example `agent:<agent_id>:main`. |
| `run_id` | Runtime run id. |
| `turn_id` | Model turn id inside a run. |
| `tool_call_id` | Tool invocation id. |
| `duration_ms` | Wall-clock duration for a bounded operation. |
| `error_code` | Stable, queryable failure class. |
| `retryable` | Whether the caller believes retrying can succeed. |

All PRs should use structured JSON logs through the shared runtime logger where the code runs inside `parallel-agent-runtime`. Logs must continue to redact secrets, bearer tokens, service-role keys, raw credentials, and full prompt/tool payloads unless an environment-gated debug mode explicitly opts in.

## PR1: Database Request Logging Wrapper

Target repo: `parallel-agent-runtime`.

Add database-level instrumentation to `SymphonyElixir.PostgRESTClient` so every Supabase/PostgREST request can emit a started/completed/failed event with consistent metadata.

Suggested scope:

- Wrap `Req.request/2` in timing and structured error handling.
- Log method, table, query shape, status code, response row count when cheap, duration, and retryability.
- Add stable events such as `postgrest_request_started`, `postgrest_request_completed`, and `postgrest_request_failed`.
- Add stable error codes such as `db_http_error`, `db_request_failed`, `db_timeout`, and `db_missing_config`.
- Accept optional log metadata from callers so manager, gateway, launcher, and message-log writes can attach `workspace_id`, `agent_id`, `run_id`, and `trace_id`.
- Keep headers and payloads redacted by default.

Validation:

- Unit tests around successful response, non-2xx response, request failure, redaction, and duration/log metadata.
- `cd apps/orchestrator && mix compile --warnings-as-errors && mix test`.

## PR2: Database Caller Context Propagation

Target repo: `parallel-agent-runtime`.

Thread caller context into database adapters so the new PostgREST logs can be joined to the user-visible operation that triggered them.

Suggested scope:

- Update `MessageLog`, `BrokerLog`, `AgentInventory.Database`, `Tracker.Database`, manager workspace reads, and launcher engine-instance writes to pass log metadata into `PostgRESTClient`.
- Standardize caller labels such as `message_log.record_user_message`, `broker_log.finish_run`, and `launcher.engine_instance.heartbeat`.
- Include table names and action names, not raw SQL or full JSON bodies.
- Wrap adapter entry points with small helper functions that convert low-level failures into contextual errors before logging.
- Add tests for at least one representative caller per adapter family.

Validation:

- Adapter tests assert context metadata reaches the client stub.
- `cd apps/orchestrator && mix compile --warnings-as-errors && mix test`.

## PR3: Database Write Failure Surfacing

Target repo: `parallel-agent-runtime`.

Make best-effort persistence failures visible without breaking request flow where the current behavior is intentionally non-fatal.

Suggested scope:

- Replace plain `Logger.warning("... #{inspect(reason)}")` persistence warnings with structured logs.
- Include `workspace_id`, `agent_id`, `session_thread_id`, `message_id`, `run_id`, and operation name where available.
- Classify non-fatal persistence failures separately from request-fatal failures with error codes like `message_persistence_failed` and `broker_persistence_failed`.
- Ensure message-log, broker-log, and engine-instance failures include enough context to retry or inspect the affected row manually.
- Document which persistence paths remain best-effort.

Validation:

- Tests for gateway message persistence warnings and manager message persistence warnings.
- Manual smoke can use the existing Supabase outage/missing-env behavior where available.

## PR4: Runtime Log Formatting and Schema Guardrails

Target repo: `parallel-agent-runtime`.

Harden `SymphonyElixir.RuntimeLog` so structured logging is easier to use correctly across the codebase.

Suggested scope:

- Add helper APIs for common operation wrappers, for example `RuntimeLog.timed/4` or `RuntimeLog.with_error_log/4`.
- Normalize atom/string keys and event names consistently.
- Add a small allowlist or test fixture for required fields on high-value events.
- Make JSON encoding failures impossible to crash the caller by falling back to a redacted encode-safe shape.
- Add tests for nested redaction, non-JSON-safe values, and event field normalization.

Validation:

- Unit tests for logger helper behavior and redaction.
- A grep-based check or test that representative events have required fields.

## PR5: Gateway and WebSocket Boundary Logs

Target repos: `parallel-agent-runtime` and `parallel-agent-platform`.

Improve logs at the HTTP/WebSocket boundary where user requests enter the runtime.

Suggested scope:

- Ensure the platform creates or forwards `trace_id` for HTTP requests and WebSocket upgrades.
- Ensure gateway open/close, frame rejection, upstream failure, and request failure logs share `trace_id`, `connection_id`, `workspace_id`, `agent_id`, and `session_key`.
- Add close code, protocol version, frame method, and sanitized error code fields.
- Convert remaining text-only gateway warnings into structured runtime logs.
- Add one browser/gateway smoke note showing how to search logs for a single trace.

Validation:

- Gateway socket tests for trace propagation and rejected-frame logging.
- Manual smoke through `http://127.0.0.1:5173` when platform changes are included.

## PR6: Launcher Lifecycle and Engine Instance Logs

Target repo: `parallel-agent-runtime`.

Make launcher-side start/stop/restart and `engine_instance` reconciliation failures easier to diagnose.

Suggested scope:

- Wrap launcher operations with operation-scoped logging helpers.
- Include host, port, engine instance id, desired state, actual state, restart count, profile summary, and duration.
- Classify startup failures by source: port allocation, process spawn, health check, database heartbeat, config resolution, or runtime crash.
- Add structured logs around state-file read/write failures.
- Ensure launcher health endpoints expose the latest structured failure summary without requiring raw log access.

Validation:

- Launcher server/state-manager tests for classified failures.
- `pnpm run smoke:runtime` when local services and env are available.

## PR7: Manager Scheduler and Work Item Polling Logs

Target repo: `parallel-agent-runtime`.

Add deeper logs around manager-agent scheduling, polling, and task pickup because these failures often look like "nothing happened."

Suggested scope:

- Log scheduler tick start/completion/failure with workspace id, manager agent id, due count, picked count, skipped count, and duration.
- Add structured reasons for skipped work items, such as missing session, stale lock, invalid profile, disabled manager, or no due items.
- Wrap polling functions with contextual error handling so database or profile failures include the work item id when available.
- Include `last_error` updates and scheduler health state in logs using the same error codes.
- Add a runbook snippet for using `pnpm run smoke:manager -- --workspace-id <workspace-id>` alongside logs.

Validation:

- Scheduler tests for skip reasons and failure classification.
- `pnpm run smoke:manager -- --workspace-id <workspace-id>` when a workspace is available.

## PR8: Model Provider Call Logs

Target repo: `parallel-agent-runtime`.

Make model-provider failures queryable and comparable across OpenAI Responses, OpenAI-compatible chat, local relay, Codex, and OpenClaw runners.

Suggested scope:

- Log model call start, first-token/first-event latency where streaming applies, completion, and failure.
- Include provider, model, runner kind, credential scope/id suffix, status code, provider request id, duration, retry count, and retryability.
- Normalize provider failures into stable error codes such as `provider_auth_failed`, `provider_rate_limited`, `provider_timeout`, `provider_invalid_request`, `provider_stream_interrupted`, and `provider_unknown`.
- Avoid logging full prompts, raw tool outputs, or API keys.
- Add helper functions so provider clients do not duplicate classification logic.

Validation:

- Unit tests for status-code/error-body classification.
- Existing manager model-client tests and runner tests.

## PR9: Tool Execution and Shell Command Logs

Target repo: `parallel-agent-runtime`.

Improve logs for tool execution, local model coding tools, shell execution, patch application, filesystem operations, and git operations.

Suggested scope:

- Log tool call start/completion/failure with `tool_call_id`, parent `turn_id`, `run_id`, tool name, sanitized argument summary, duration, exit code, and output truncation metadata.
- Classify errors as `tool_denied`, `tool_timeout`, `tool_process_failed`, `tool_invalid_args`, `tool_dependency_missing`, or `tool_unknown`.
- Redact command output and environment values using the same sensitive-key policy as runtime logs.
- Wrap shell execution helpers with consistent timeout and stderr logging.
- Add opt-in debug capture for truncated output when safe.

Validation:

- Unit tests around shell/tool classification and redaction.
- Existing local model coding executor tests.

## PR10: Agent-Facing Log Summaries and Diagnostic Views

Target repos: `parallel-agent-runtime` and `parallel-agent-platform`.

Expose curated summaries of recent failures so humans and manager agents do not need direct CloudWatch or raw log access for common diagnosis.

Suggested scope:

- Add runtime-side in-memory recent event summaries keyed by agent/session/run.
- Extend health or diagnostic endpoints to include last database failure, last model failure, last tool failure, and last gateway failure.
- Add platform diagnostic rendering for the same fields.
- Keep raw logs out of the API response; expose event name, time, error code, scoped ids, retryability, and a short sanitized message.
- Document when to use diagnostic endpoints versus raw log search.

Validation:

- Controller tests for sanitized diagnostic payloads.
- Manual diagnostic endpoint smoke:
  `curl "http://127.0.0.1:3100/api/diagnostic/agents/<agent-id>?workspaceId=<workspace-id>"`.

## PR11: Production Log Pipeline and Alerting

Target repos: `parallel-agent-runtime`, `parallel-agent-platform`, and deployment infrastructure.

Connect the improved structured logs to production search, metrics, and alerts.

Suggested scope:

- Ensure deployed logs are single-line JSON and include service name, environment, deployment id, container/task id, and host.
- Add CloudWatch metric filters or equivalent metrics for database failures, model failures, tool failures, abnormal WebSocket closes, launcher restarts, and manager scheduler failures.
- Add dashboards by trace id, workspace id, agent id, event, and error code.
- Add alert thresholds for repeated database failures, manager scheduler `last_error`, provider auth failures, and launcher restart loops.
- Document production log search examples for common incidents.

Validation:

- Staging deployment verification with sample events.
- Runbook entries with exact query examples.

## PR12: Cross-Repo Logging Tests and Smoke Scripts

Target repos: `parallel-agent-runtime` and `parallel-agent-platform`.

Add tests and smoke scripts that prove logs are emitted across boundaries, not just in isolated unit tests.

Suggested scope:

- Add a local smoke that sends a trace id through platform API, launcher, gateway, runtime, and a database call.
- Capture process logs and assert required event names and correlation fields exist.
- Extend `pnpm run smoke:runtime` to optionally verify structured log lines for launcher/orchestrator health checks.
- Add a manager smoke option that validates scheduler tick logs for a workspace.
- Add CI-friendly fixtures that avoid printing secrets.

Validation:

- `pnpm run smoke:runtime`.
- `pnpm run smoke:manager -- --workspace-id <workspace-id>` when manager changes are included.
- `cd apps/orchestrator && mix compile --warnings-as-errors && mix test`.

## Suggested Parallelization

| Lane | PRs | Notes |
| --- | --- | --- |
| Database lane | PR1, PR2, PR3 | Start with the wrapper, then fan out caller context and failure surfacing. |
| Runtime core lane | PR4, PR8, PR9 | Can proceed after agreeing on shared field names and error-code conventions. |
| Boundary lane | PR5, PR6 | Gateway and launcher work can proceed mostly independently. |
| Manager lane | PR7 | Depends lightly on database context conventions from PR1/PR2. |
| Product/ops lane | PR10, PR11, PR12 | Best after the event vocabulary stabilizes, but API and smoke skeletons can start earlier. |

## Open Decisions

- Whether to introduce OpenTelemetry spans now or keep this phase to structured logs and trace ids.
- Whether database request logs should be sampled in production after baseline metrics exist.
- Where to store recent event summaries for multi-process deployments: runtime memory, platform cache, or a dedicated event sink.
- Which event names and error codes should be treated as contract-level values with compatibility expectations.
