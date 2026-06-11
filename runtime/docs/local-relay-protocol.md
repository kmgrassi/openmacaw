# Local Relay Protocol

The local runtime helper connects to the runtime relay over WebSocket and
exchanges JSON frames with `schema_version: "1"`.

## Failure Frames

Helper failures use `type: "error"` and are scoped to the dispatch by
`correlation_id`.

```json
{
  "type": "error",
  "schema_version": "1",
  "correlation_id": "dispatch_123",
  "code": "provider_error",
  "error_code": "provider_rate_limited",
  "message": "ollama rate limit exceeded",
  "retryable": true,
  "detail": {
    "http_status": 429,
    "endpoint": "http://127.0.0.1:11434/v1/chat/completions",
    "raw_message": "{\"error\":{\"message\":\"rate limit exceeded\"}}"
  }
}
```

`code` remains the helper-local protocol or runner error class. When the
failure came from a model provider, `error_code` carries the canonical
provider failure code consumed by runtime cutover handling:

- `provider_rate_limited`
- `provider_timeout`
- `provider_overloaded`
- `provider_stream_interrupted`
- `provider_content_refused`
- `provider_unknown`
- `provider_invalid_request`
- `provider_auth_failed`

Retryable provider codes are `provider_rate_limited`, `provider_timeout`,
`provider_overloaded`, `provider_stream_interrupted`,
`provider_content_refused`, and `provider_unknown`.

Helpers should set `error_code` only for provider/model failures. Local relay
transport failures continue to use local codes such as
`local_runtime_offline`, `local_runner_busy`, `local_runner_timeout`, and
`local_runner_protocol_error`.
