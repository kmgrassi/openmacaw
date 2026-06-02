# End-to-End Logging Improvement PR Plan

## Goal

Make production failures diagnosable across the full stack: browser, API,
database, WebSocket proxy, runtime launcher/orchestrator, workers, model
providers, and infrastructure.

The platform already has a structured API logger, request context storage, ECS
metadata enrichment, and Supabase error logging. The next step is to make those
patterns consistent at every boundary and add enough database-level and
cross-service context that an operator can answer:

- Which user, workspace, agent, session, request, run, turn, or tool call was
  involved?
- Which layer failed: browser, API validation, auth, database, launcher,
  WebSocket proxy, runtime, model provider, tool execution, or infrastructure?
- What query, route, upstream request, or operation was running?
- Was the error retryable, user-actionable, or an operator issue?
- Which PR or service should own the fix?

## Logging Principles

- **Structured first:** emit machine-readable records with stable keys instead
  of prose-only `console.log` messages.
- **One correlation chain:** preserve `trace_id`, `request_id`, `workspace_id`,
  `agent_id`, `session_key`, `run_id`, `turn_id`, and `tool_call_id` across
  every service that participates in a user action.
- **Database context without data leakage:** log table, operation, filters
  summary, row counts, duration, Postgres code, details, and hints, but never
  credentials, auth tokens, or large payloads.
- **Errors are classified:** every caught error should have a stable
  application error code, retryability, and layer.
- **Logs should be useful locally and in production:** keep JSON logs for
  deployed environments, but provide pretty formatting for local development and
  test failures.
- **No silent fallbacks:** swallowed errors, best-effort writes, and fallback
  branches must log the decision and the reason.

## Shared Log Shape

All layers should converge on a shape like:

```json
{
  "level": "error",
  "timestamp": "2026-05-01T12:00:00.000Z",
  "service": "platform-api",
  "environment": "production",
  "event": "database_query_failed",
  "trace_id": "trc_...",
  "request_id": "req_...",
  "workspace_id": "...",
  "agent_id": "...",
  "operation": "agent_dashboard.load",
  "layer": "database",
  "error_code": "postgres_foreign_key_violation",
  "retryable": false,
  "duration_ms": 42
}
```

## Suggested PR Sequence

### PR1: Database Query Wrapper and Timing Logs

Repository: `parallel-agent-platform`

Scope:

- Add a small helper around Supabase query execution, building on
  `executeSupabaseRows`, `normalizeSupabaseError`, and
  `assertSupabaseSuccess`.
- Log `database_query_started`, `database_query_completed`, and
  `database_query_failed` with table name, operation name, duration, row count,
  result cardinality, and Supabase/Postgres error fields.
- Require callers to pass a domain operation name such as
  `agent_dashboard.load_agents` instead of generic contexts like
  `credential query`.
- Keep request context propagation from `requestContextStorage` so DB logs
  automatically include `trace_id` and `request_id`.

Acceptance:

- New database helper is covered by unit tests.
- At least two representative query paths are migrated.
- No secrets, SQL literals, or access tokens appear in logs.

Parallelism:

- Blocks PR2 and PR3 if they depend on the new helper, but can land before
  other stack-level logging PRs.

### PR2: Repository-Level Error Boundaries

Repository: `parallel-agent-platform`

Scope:

- Wrap repository functions with a shared `withRepositoryLogging` helper.
- Add operation-specific metadata: repository name, method name, table, expected
  cardinality, workspace scope, and whether the call used service-role or
  user-scoped Supabase.
- Convert broad thrown errors into stable API/domain error codes while
  preserving the original cause for logs.
- Add tests proving repository failures include full Supabase details in logs
  and sanitized details in API responses.

Acceptance:

- Repository logs identify the exact repository method that failed.
- `cause` is preserved when errors are rethrown.
- Tests cover both missing-row and Supabase-error paths.

Parallelism:

- Can be split by repository area after PR1: agents, credentials, setup,
  tools, work items.

### PR3: Database Constraint and Migration Diagnostics

Repository: `parallel-agent-platform` plus migration-owning repo when needed.

Scope:

- Add a diagnostic endpoint or script that checks current Supabase schema
  version, generated type freshness, expected extensions, and critical
  constraints.
- Log failures from schema drift checks with `database_schema_drift_detected`.
- Improve migration/test harness output so failed constraints identify the
  table, constraint, expected value, and offending enum/string.
- Document how to correlate a runtime database error with a migration or stale
  generated type.

Acceptance:

- Local script emits clear pass/fail structured output.
- CI failures for schema/type drift point to the owning artifact.
- Diagnostic output avoids dumping full table data.
- Runbook: [Database Schema Diagnostics](../reference/database-schema-diagnostics.md).

Parallelism:

- Independent from API route logging once the DB helper exists.

### PR4: API Route Request Lifecycle Logs

Repository: `parallel-agent-platform`

Scope:

- Add or harden Express middleware that logs `request_started`,
  `request_completed`, and `request_failed`.
- Include route pattern, method, status code, duration, user id when known,
  workspace id when known, and response error code.
- Normalize uncaught route exceptions through one logging path.
- Add a local pretty formatter for API logs to make dev-server debugging easier
  without changing production JSON output.

Acceptance:

- Every API route has a start/completion/failure record.
- 4xx and 5xx failures can be separated in logs.
- Pretty output is opt-in for local development.

Parallelism:

- Independent from WebSocket/runtime logging.

### PR5: Error Handling Wrappers for Service Functions

Repository: `parallel-agent-platform`

Scope:

- Introduce `withServiceLogging` for high-value service functions such as
  runtime preparation, execution profile resolution, credential resolution,
  setup orchestration, agent control, and tool execution.
- Log input summaries, not raw payloads.
- Track `service_operation_started`, `service_operation_completed`, and
  `service_operation_failed` with duration and stable error classification.
- Flag swallowed or converted errors with `handled: true` and the next action.

Acceptance:

- At least three high-risk services use the wrapper.
- Error causes remain inspectable in tests.
- Logs clearly distinguish user-fixable setup/config errors from operator
  failures.

Parallelism:

- Can be parallelized by service area after a shared wrapper lands.

### PR6: WebSocket and Gateway Correlation Logs

Repository: `parallel-agent-platform`

Scope:

- Extend existing WebSocket proxy logs with connection ids, close codes, close
  reasons, upstream URL category, handshake duration, auth result, and
  downstream/upstream byte or message counts.
- Log protocol mismatch, missing token, invalid token, launcher-unavailable,
  upstream timeout, and abnormal close with distinct event names.
- Ensure `trace_id` and `request_id` are forwarded to runtime services and
  echoed in proxy logs.

Acceptance:

- One WebSocket session can be traced from browser request through API proxy to
  runtime upstream.
- Abnormal closes are searchable by close code and agent id.
- Token-bearing URLs and headers remain redacted.

Parallelism:

- Independent from repository/service logging.

### PR7: Runtime Launcher and Orchestrator Event Vocabulary

Repository: `parallel-agent-runtime`

Scope:

- Mirror the platform log shape in launcher and orchestrator services.
- Emit lifecycle events for agent start, process spawn, heartbeat, stop,
  restart, runtime session creation, run start, run completion, and run failure.
- Preserve platform correlation headers and attach runtime identifiers such as
  `run_id`, `turn_id`, and `worker_id`.
- Normalize launcher/orchestrator errors into stable codes.

Acceptance:

- A single agent start can be followed across platform API, launcher,
  orchestrator, and database writes.
- Runtime logs use the same correlation field names as the platform.
- Startup and heartbeat failures include enough context to determine whether the
  cause is config, database, process, or network.

Parallelism:

- Can run independently in the runtime repo once the shared field vocabulary is
  agreed.

### PR8: Model Provider and Tool Execution Logs

Repository: `parallel-agent-runtime`

Scope:

- Wrap model provider calls with start/completion/failure logs including
  provider, model, credential reference, provider request id, token counts,
  first-token latency, total duration, retry count, and retryability.
- Wrap tool calls with tool name, execution kind, allow/deny decision, sanitized
  argument summary, exit status, duration, and parent run/turn ids.
- Classify failures as provider auth, rate limit, timeout, overload, invalid
  request, stream interruption, tool denied, tool timeout, dependency missing,
  process failed, or unknown.

Acceptance:

- Failed model and tool calls can be grouped by provider/model/tool and
  retryability.
- Prompt content, tool payloads, and credentials are redacted by default.
- Streaming failures include enough phase information to know whether the stream
  failed before first token, mid-stream, or during finalization.

Parallelism:

- Can be split between model providers and tool execution once PR7 establishes
  runtime logger helpers.

### PR9: Browser Client Diagnostics and Console Cleanup

Repository: `parallel-agent-platform`

Scope:

- Replace scattered browser `console.warn`, `console.error`, and `console.debug`
  calls with a small client logger that includes route, workspace id, agent id,
  request id, and feature area.
- Add request id headers to broker/API calls and WebSocket connections where
  practical.
- Add user-visible error codes to frontend error states so screenshots and bug
  reports map back to logs.
- Keep noisy debug events gated behind a dev flag.

Acceptance:

- Browser logs use consistent prefixes and metadata.
- API and WebSocket client calls can be correlated with server logs.
- Production users are not exposed to raw internal errors.

Parallelism:

- Independent from backend DB logging, but should use the same field names.

### PR10: Operational Formatting, Dashboards, and Alerts

Repository: `parallel-agent-platform` plus deployment infrastructure.

Scope:

- Define log queries or dashboards for database failures, route 5xx rate,
  WebSocket abnormal closes, launcher failures, runtime heartbeats, model
  failures, and tool failures.
- Add metric filters or equivalent alert rules for critical events.
- Provide a `scripts/log-pretty` or documented `jq` pipeline for local JSON log
  formatting.
- Add a runbook mapping event names to owner, likely cause, and first
  diagnostic command.

Acceptance:

- Operators can answer "what broke in the last 15 minutes?" without raw log
  spelunking.
- Alerts point to the event name, service, environment, and runbook section.
- Local development logs are readable without losing production structure.

Parallelism:

- Can proceed after PR4, PR6, PR7, and PR8 define the event vocabulary.

## Cross-PR Guardrails

- Do not log bearer tokens, cookies, API keys, raw prompt text, or full tool
  payloads by default.
- Keep enum-like log values in `snake_case`.
- Prefer typed wrappers and explicit operation names over ad hoc string
  formatting at call sites.
- Preserve `cause` when converting errors.
- Add tests around redaction and error classification for every shared helper.
- Avoid compatibility aliases for event names; rename events consistently across
  producers and consumers in the same PR.

## First Slice Recommendation

Start with PR1 and PR4 together:

- PR1 makes database failures identifiable and timed.
- PR4 ensures every request has a lifecycle envelope.

Together they create the baseline correlation chain needed for the remaining
runtime, browser, and operational improvements.
