# Worker Bridge

This document captures the current launcher-hosted worker bridge and how the
platform stack is expected to call it.

## What it is

The worker bridge is a small launcher-side API for spawning background worker
processes with scoped credentials.

It lives inside the runtime repo:

- `SymphonyElixir.Launcher.Supervisor`
- `SymphonyElixir.Launcher.Router`
- `SymphonyElixir.WorkerBridge.Server`
- `SymphonyElixir.WorkerBridge.CredentialResolver`
- `SymphonyElixir.WorkerBridge.RepositoryManager`

## Startup path

When the launcher starts with:

```bash
mix launcher.start
```

the process tree includes:

1. `SymphonyElixir.Launcher.Supervisor`
2. `SymphonyElixir.WorkerBridge.Server`
3. `Bandit` serving `SymphonyElixir.Launcher.Router`

That means the worker-bridge API becomes available on the launcher port as soon
as the launcher is up. By default that port is `4100`.

Health check:

```bash
curl http://127.0.0.1:4100/health
```

## API surface

The launcher HTTP server exposes:

- `POST /worker-bridge/sessions`
- `GET /worker-bridge/sessions`
- `GET /worker-bridge/sessions/:id`
- `DELETE /worker-bridge/sessions/:id`

Response shape for a session:

```json
{
  "id": "worker_1234abcd",
  "kind": "codex",
  "command": "codex app-server",
  "cwd": "/tmp/symphony-workspaces/PLAT-123",
  "status": "running",
  "heartbeat_at": "2026-04-15T15:00:00Z",
  "idle_expires_at": "2026-04-15T15:15:00Z",
  "max_expires_at": "2026-04-15T18:00:00Z",
  "started_at": "2026-04-15T15:00:00Z",
  "stopped_at": null,
  "exit_status": null,
  "env_keys": ["OPENAI_API_KEY"],
  "credential_keys": ["OPENAI_API_KEY"]
}
```

## Request shapes

The preferred platform-facing contract is repository intent:

```json
{
  "kind": "codex",
  "repository": {
    "url": "https://github.com/org/repo.git",
    "ref": "main"
  },
  "env": {
    "OPENAI_BASE_URL": "https://api.openai.com/v1"
  },
  "credentials": {
    "OPENAI_API_KEY": {
      "source": "inline",
      "value": "sk-..."
    }
  }
}
```

The bridge also accepts a direct `cwd` for internal callers:

```json
{
  "kind": "codex",
  "cwd": "/tmp/symphony-workspaces/PLAT-123",
  "credentials": {
    "OPENAI_API_KEY": {
      "source": "inline",
      "value": "sk-..."
    }
  }
}
```

Behavior:

- the caller specifies `kind`, not a required CLI command
- for `kind: "codex"`, the launcher resolves the default command from `WORKFLOW.md` via `codex.command`
- the caller can supply `repository.url` and optional `repository.ref`, and the server prepares a local workspace automatically
- `cwd` is still accepted as an escape hatch, but it must already exist and stay inside the configured `workspace.root`
- an internal caller can still override `command` for testing or controlled server-side customization

## Platform contract

The platform client/server should call the launcher with a high-level worker
request instead of choosing the raw shell command itself.

That keeps the command definition owned by the runtime while the platform only
specifies:

- worker kind
- repository or working directory
- extra environment
- credential material to inject

Low-level callers may still provide an explicit `"command"` directly, but the
platform path should prefer `"kind": "codex"`.

## Request flow

End-to-end flow for a platform-triggered worker launch:

1. Web client asks the platform API to start a worker.
2. Platform API resolves any stored secret reference into a concrete value.
3. Platform API sends `POST /worker-bridge/sessions` to the launcher.
4. `Launcher.Router` forwards the body to `WorkerBridge.Server.start_session/1`.
5. `WorkerBridge.Server` resolves credentials and workspace source:
   - `repository` requests prepare a local workspace through `RepositoryManager`
   - `cwd` requests are canonicalized and constrained to `workspace.root`
6. For `"kind": "codex"`, the bridge resolves the default command from `Config.settings!().codex.command`.
7. The worker process is spawned with:
   - command
   - cwd
   - merged env + credentials
8. The launcher returns session metadata to the platform caller.

## Lease and cleanup tracking

Each worker-bridge session writes a runtime lease through
`SymphonyElixir.RuntimeLease.Registry`. The lease records session identity,
workspace and agent IDs when present, heartbeat time, idle deadline, max
lifetime deadline, optional materialized resource grant versions, and the
repository workspace cleanup path.

Default worker-bridge lease deadlines are:

- idle timeout: 15 minutes
- max lifetime: 3 hours

Callers can override these for controlled tests or future warm-worker sessions
with a `lease` object:

```json
{
  "kind": "codex",
  "cwd": "/tmp/symphony-workspaces/PLAT-123",
  "lease": {
    "idle_timeout_ms": 900000,
    "max_lifetime_ms": 10800000,
    "materialized_grant_versions": {
      "grant_123": 4
    }
  }
}
```

The server exposes internal heartbeat and reaper functions for the launcher
runtime path:

- `SymphonyElixir.WorkerBridge.Server.heartbeat_session/1`
- `SymphonyElixir.WorkerBridge.Server.reap_stale_sessions/1`

The generic lease registry also supports task leases and orphan detection via
`SymphonyElixir.RuntimeLease.Registry.mark_orphaned_tasks/3`, which gives the
AWS adapter a provider-neutral place to record and reconcile ECS task ARNs.

## Storage roots

Repository cache/storage roots:

- default root: `#{System.tmp_dir!()}/symphony_worker_bridge` conceptually, implemented as the system temp dir plus `symphony_worker_bridge`
- configurable via app env: `:symphony_elixir, :worker_bridge_root`
- configurable via env var: `SYMPHONY_WORKER_BRIDGE_ROOT`

That lets local development use temp storage while AWS can point the bridge at
an EFS mount such as `/mnt/efs/symphony_worker_bridge`.

## Supported credential sources

Supported credential sources today:

- `inline`
- `env`

Example launcher-host env reference:

```json
{
  "credentials": {
    "OPENAI_API_KEY": {
      "source": "env",
      "name": "WORKER_OPENAI_API_KEY"
    }
  }
}
```

## Local debug loop

Start the launcher locally:

```bash
pnpm run start:launcher
```

List sessions:

```bash
curl http://127.0.0.1:4100/worker-bridge/sessions
```

Start a local Codex worker:

```bash
curl -X POST http://127.0.0.1:4100/worker-bridge/sessions \
  -H 'content-type: application/json' \
  -d '{
    "kind": "codex",
    "cwd": "/tmp/symphony-workspaces/ISSUE-123",
    "credentials": {
      "OPENAI_API_KEY": { "source": "env", "name": "OPENAI_API_KEY" }
    }
  }'
```

## Deliberate limitations

This is still a launcher-local process bridge.

Not implemented in this slice:

- AWS SSM / Secrets Manager resolution
- Vault resolution
- SSH or remote-host worker launch
- automatic wiring into orchestrator dispatch
- browser-authenticated UI flow or server-side authz policy
- credential rotation policies

## Follow-up work

1. Add pluggable secret resolvers for SSM and Vault.
2. Add remote launch targets (SSH and container/task backends).
3. Add authz around who can create worker sessions and which credential sources are permitted.
4. Add a `worker_host_bridge` adapter so orchestrator dispatch can launch workers through this API.
5. Replace inline credentials in user-facing flows with short-lived tokens or secret references.
