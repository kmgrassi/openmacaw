# React Frontend Integration Contract

This repo can keep the orchestrator backend only, while a separate React frontend consumes
an external API contract.

## Recommended frontend model

- No chat input UX for agent turns in-app.
- Operator console only: issue state, running sessions, retries, logs, health, and manual controls.
- Pull model from `GET /api/v1/state` and poll, or subscribe to SSE/WebSocket for live updates.

## Source endpoints to expose

- `GET /api/v1/state` (global snapshot)
- `GET /api/v1/<issue_identifier>` (issue-level debug view)
- `POST /api/v1/refresh` (trigger reconciliation poll)
- `GET /` for optional legacy dashboard fallback

## Suggested React pages

1. **Overview**
   - running count, retry count, active workers, average turn durations, token totals, last failure.
2. **Queue**
   - candidate issues, active sessions, retry queue with next retry ETA.
3. **Issue detail**
   - workspace path, session id, worker host, last event, token counters, recent events, logs.
4. **Topology**
   - worker host list, ping status, per-host capacity, error counts.
5. **Health**
   - config hash, workflow timestamp, watcher status, tracker connectivity summary.

## Proposed response envelope for frontend

If the API response shape changes, preserve backward-compatible keys.

```json
{
  "generated_at": "2026-02-24T20:15:30Z",
  "counts": { "running": 2, "retrying": 1 },
  "running": [],
  "retrying": [],
  "codex_totals": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0, "seconds_running": 0.0 },
  "rate_limits": null
}
```

Add frontend-only extension fields as needed, such as:

- `meta.workflow_path`
- `meta.poller_enabled`
- `meta.last_config_error`

## Event model

Normalize backend events into a compact feed for UI to render:

- `session_started`, `turn_completed`, `turn_failed`, `turn_cancelled`,
- `turn_ended_with_error`, `startup_failed`, `notification`, `worker_ping_failed`.

## Build/deploy posture

- Keep React project in a separate repository/module.
- Use token/cors-safe client config per environment.
- Do not embed API keys in frontend for worker/provider endpoints.

## Optional realtime mode

- Add server-side SSE stream:
  - `GET /api/v1/events`
  - emits periodic snapshots and runtime events.
- Or switch to WebSocket if you already run a gateway layer.

