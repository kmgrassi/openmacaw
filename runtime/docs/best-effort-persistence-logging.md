# Best-Effort Persistence Logging

The runtime keeps several durability writes best-effort so transient database
or network failures do not break the user-facing request or scheduler tick that
triggered them.

These paths remain intentionally non-fatal:

- Gateway chat transcript writes through `SymphonyElixir.MessageLog`:
  `session_thread` upsert, user message insert, and assistant message insert.
- Broker execution-history writes through `SymphonyElixir.BrokerLog`:
  `broker_run` start/update/finish/reconcile and `broker_task` turn inserts.
- Launcher `engine_instance` writeback paths, which already emit structured
  `engine_instance_*_failed` runtime events when the async write fails.

Failures in these paths are emitted as structured runtime logs with stable
error codes:

- `gateway_message_persistence_failed` for gateway transcript persistence, with
  `error_code: "message_persistence_failed"`.
- `broker_persistence_failed` for broker execution-history persistence.
- `engine_instance_*_failed` for launcher instance writeback.

Each event includes the operation name, available workspace/agent/run/session
identifiers, retryability, and `non_fatal: true`. The failed write is not
retried synchronously by the request handler; operators can use the logged ids
to inspect or repair the affected row manually.
