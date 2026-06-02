# Observability

## Health Checks

### Primary Health Endpoint

```
GET /health
```

Returns aggregate health of the server and its upstream dependency:

```json
{
  "ok": true,
  "service": "symphony-express-server",
  "orchestrator_base_url": "http://127.0.0.1:4000",
  "orchestrator_health": { "ok": true }
}
```

| Field | Meaning |
|-------|---------|
| `ok: true` | Server is up AND orchestrator is healthy |
| `ok: false` (503) | Server is up but orchestrator is down or unhealthy |
| No response | Server process is down |

### Upstream Health

```
GET /api/v1/health
```

Direct proxy to the orchestrator's health endpoint. Use this to diagnose whether issues are in the gateway or upstream.

## Error Codes

All errors follow the shape `{ error: { code, message, details } }`.

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `orchestrator_timeout` | 504 | Upstream didn't respond within timeout |
| `orchestrator_unreachable` | 502 | Couldn't connect to upstream at all |

## Monitoring Checklist

After deploying, monitor for the first 15 minutes:

1. **Health check**: `curl /health` returns `{ "ok": true }`.
2. **Proxy connectivity**: `curl /api/v1/health` returns 200.
3. **Error rate**: Watch for 502/504 responses.
4. **Response times**: Proxy responses should be under the timeout threshold.

## Logging

Currently the server uses `console.log` for startup messages. As the project grows, structured logging should be added:

### Recommended Logging Strategy

When adding structured logging, follow these practices:

- **Log at request boundaries**: Log when a request arrives and when a response is sent.
- **Include request ID**: Add a unique ID to each request for tracing.
- **Log proxy calls**: Log outbound calls to the orchestrator with timing.
- **Structured JSON**: Use a logger like `pino` that outputs JSON for machine parsing.

Example future structure:

```typescript
// Request log
{ "level": "info", "requestId": "abc123", "method": "GET", "path": "/api/v1/state", "status": 200, "durationMs": 45 }

// Error log
{ "level": "error", "requestId": "abc123", "code": "orchestrator_timeout", "path": "/api/v1/state", "durationMs": 15000 }
```

## Alerts to Configure

| Condition | Severity | Action |
|-----------|----------|--------|
| `/health` returns non-200 | Critical | Investigate orchestrator connectivity |
| Error rate > 5% over 5min | Warning | Check orchestrator health and logs |
| Response time p95 > 10s | Warning | Review timeout config and orchestrator performance |
| Server process not running | Critical | Restart and check crash logs |

## Debugging Production Issues

### Server returns 502

1. Check if the orchestrator is running: `curl $ORCHESTRATOR_BASE_URL/api/v1/health`
2. Check network connectivity between server and orchestrator.
3. Verify `ORCHESTRATOR_BASE_URL` is set correctly.

### Server returns 504

1. The orchestrator is reachable but too slow.
2. Check orchestrator load and performance.
3. Consider increasing `ORCHESTRATOR_REQUEST_TIMEOUT_MS` if the slowness is expected.

### Server won't start

1. Check that `PORT` is not in use: `lsof -i :3100`
2. Check that all env vars are set.
3. Check Node.js version: `node -v` (must be >= 20).
4. Run `pnpm run build` to check for compilation errors.
