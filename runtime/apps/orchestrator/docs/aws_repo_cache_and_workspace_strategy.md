# AWS Repo Cache and Workspace Strategy

This document scopes a first-class repository cache and workspace subsystem for AWS deployments.

It is intentionally written so agents can implement it in small vertical slices instead of trying
to land the whole storage model at once.

## 1) Problem statement

The worker bridge and future remote workers need repository data to be:

- durable across worker restarts,
- fast to materialize into session workspaces,
- isolated so active sessions do not mutate shared cache state,
- bounded so storage does not grow without limit,
- observable so operators can see cache health, size, and churn.

The anti-goal is allowing every worker to keep arbitrary full checkouts in `/tmp` indefinitely.

## 2) Design goals

- Use persistent shared storage for reusable repository cache data.
- Use disposable per-session workspaces for active code execution.
- Keep artifact storage separate from git storage.
- Support many repositories without cloning from origin for every session.
- Make storage roots configurable by environment.
- Make cleanup and eviction explicit rather than implicit.
- Keep the architecture compatible with ECS/Fargate first.

## 3) Recommended storage model

### 3.1 Persistent repo cache

Store one long-lived mirror per repository on persistent storage.

Recommended medium:

- **AWS EFS**

Recommended shape:

```text
/mnt/efs/symphony/repo-cache/<repo-cache-id>
```

Rules:

- Cache entries are **not** active workspaces.
- Cache entries should be treated as managed server-side assets.
- Cache entries should be refreshed in place with controlled write access.
- Cache entries should never be used directly as the worker `cwd`.

### 3.2 Session workspaces

Store one mutable workspace per running worker session.

Recommended medium:

- **local ephemeral disk** on the ECS task or compute node when available
- fallback to EFS only when local disk is not viable

Recommended shape:

```text
/var/lib/symphony-worker/sessions/<session-id>
```

Rules:

- Session workspaces are derived from the persistent repo cache.
- Session workspaces are disposable.
- Session workspaces should be deleted after session completion or timeout.
- Session workspaces should be isolated from each other.

### 3.3 Artifacts and logs

Store logs, output bundles, and optional snapshots separately from both cache and session
workspace storage.

Recommended medium:

- **AWS S3**

Recommended examples:

- `s3://<bucket>/worker-artifacts/<session-id>/...`
- `s3://<bucket>/worker-logs/<date>/<session-id>.log`

Rules:

- Do not keep long-term logs inside the repo cache.
- Do not rely on session workspaces for durable evidence.

### 3.4 Metadata and leases

Store operational metadata in a database, not in ad-hoc marker files alone.

Candidates:

- Postgres / Supabase
- DynamoDB

Required records:

- repository registry
- cache refresh lease
- session workspace lease
- cleanup status
- last used timestamps
- size and health summaries

## 4) Recommended AWS deployment shape

### 4.1 Baseline ECS model

- Launcher / API service runs in ECS.
- Worker sessions run locally in the same task for MVP or in dedicated worker tasks later.
- EFS is mounted into the task for persistent repo cache storage.
- Local ephemeral disk stores active session workspaces.
- S3 stores artifacts.

### 4.2 Directory layout

Suggested layout:

```text
/mnt/efs/symphony/repo-cache/
/mnt/efs/symphony/repo-cache/<repo-id>/
/var/lib/symphony-worker/sessions/
/var/lib/symphony-worker/sessions/<session-id>/
```

Suggested environment variables:

```text
SYMPHONY_REPO_CACHE_ROOT=/mnt/efs/symphony/repo-cache
SYMPHONY_SESSION_WORKSPACE_ROOT=/var/lib/symphony-worker/sessions
SYMPHONY_ARTIFACT_BUCKET=s3://...
```

### 4.3 Why this split

EFS is acceptable for durable mirror-style repo cache storage, but it is usually a worse place to
do heavy active workspace churn than local ephemeral disk.

That leads to this pattern:

- **read/update mirror on EFS**
- **materialize active workspace locally**
- **delete active workspace after run**

## 5) Cache format

### 5.1 Preferred cache representation

Use a **bare mirror** or mirror-style git repository as the persistent cache format.

This is preferable to keeping one shared mutable checkout because:

- it is closer to a source-of-truth cache,
- it is smaller and easier to reason about than many full checkouts,
- it avoids accidental mutation of a shared working tree,
- it supports creating fresh workspaces from a known source.

### 5.2 Materialization strategy

For each session:

1. find or create the repo mirror,
2. refresh it if stale,
3. create a session workspace from the mirror,
4. check out the desired ref,
5. run the worker in the session workspace,
6. archive artifacts and delete the workspace.

### 5.3 Allowed MVP simplification

The current bridge may use a non-bare cached clone temporarily, but the desired target is a
mirror-oriented cache entry with explicit refresh policy.

## 6) End-to-end flow

### 6.1 Cold repository

1. UI asks for a worker session for repo `X`.
2. API resolves repo record and requested ref.
3. Service checks metadata store for existing cache entry.
4. No cache exists.
5. Service acquires a repo refresh lease.
6. Service creates mirror on EFS.
7. Service records cache metadata.
8. Service creates local session workspace from mirror.
9. Worker launches in local workspace.
10. On completion, session workspace is deleted and artifacts are archived.

### 6.2 Warm repository

1. UI asks for a worker session for repo `X`.
2. Service finds existing mirror on EFS.
3. Service decides whether mirror is fresh enough.
4. If stale, service acquires refresh lease and fetches updates.
5. Service creates local session workspace from mirror.
6. Worker launches.
7. Session workspace is cleaned up at the end.

## 7) Concurrency model

### 7.1 Repo-level locking

Only one writer should refresh a given cache entry at a time.

Use a lease keyed by repo id:

- `repo_id`
- `lease_owner`
- `lease_acquired_at`
- `lease_expires_at`

Workers without the lease may:

- wait,
- use the currently stable cache revision,
- or fail fast if freshness is mandatory.

### 7.2 Session isolation

Every worker session gets its own workspace.

Never share a mutable working tree across concurrent sessions.

## 8) Cleanup and eviction policy

### 8.1 Session workspace cleanup

Session workspaces should be removed:

- on successful completion,
- on explicit cancellation,
- on timeout,
- by periodic janitor for stranded sessions.

### 8.2 Repo cache cleanup

Repo cache entries should not be deleted on normal session completion.

Instead, evict based on policy:

- least recently used,
- age since last access,
- total cache size threshold,
- explicit pin for critical repos.

### 8.3 Suggested policy

- keep pinned repos always,
- evict cold repos when total cache size exceeds threshold,
- never evict repos with an active refresh lease,
- never evict repos used by active sessions.

## 9) Observability requirements

Expose metrics and state for:

- total cache size
- cache entry count
- per-repo size
- cache hit vs cold clone ratio
- mirror refresh duration
- workspace materialization duration
- session workspace cleanup failures
- orphaned workspaces
- EFS storage pressure

Suggested operator API fields:

- `repo_id`
- `repo_url`
- `cache_path`
- `cache_kind`
- `last_fetched_at`
- `last_used_at`
- `cache_size_bytes`
- `active_session_count`
- `refresh_state`

## 10) Security requirements

- Keep repository credentials separate from model/provider credentials.
- Do not store model API keys in repo cache metadata.
- Restrict who can mutate cache entries.
- Restrict cache root mount paths to dedicated directories.
- Treat worker session directories as untrusted mutable data.
- Keep EFS mount permissions narrow.

## 11) Failure and recovery behavior

### 11.1 Mirror refresh fails

- keep the previous stable cache revision,
- mark refresh failure in metadata,
- allow policy-driven fallback to stale cache when acceptable.

### 11.2 Session workspace creation fails

- delete partial workspace,
- leave repo cache intact,
- return structured error to caller.

### 11.3 Task restart

- session workspaces on local ephemeral disk are lost,
- repo cache on EFS remains,
- recovery process should:
  - mark in-flight sessions as interrupted,
  - clean up metadata leases,
  - allow replay/retry from the surviving mirror.

## 12) Recommended phased implementation

### Phase 1 — Configurable roots and storage contracts

Goal: define explicit cache/session/artifact roots.

Checklist:

- [ ] Add config for `repo_cache_root`.
- [ ] Add config for `session_workspace_root`.
- [ ] Add config for artifact sink.
- [ ] Remove implicit `/tmp` assumptions from worker-facing code.
- [ ] Document local defaults and AWS overrides.

### Phase 2 — Repo registry and lease model

Goal: make repo cache state observable and safe under concurrency.

Checklist:

- [ ] Add repository registry schema/table.
- [ ] Add repo refresh lease schema/table.
- [ ] Add helper APIs for acquire, renew, release, expire.
- [ ] Add integration tests for concurrent refresh attempts.
- [ ] Add stale lease recovery rules.

### Phase 3 — Mirror cache format

Goal: move to a durable repo cache representation.

Checklist:

- [ ] Define canonical repo id derivation.
- [ ] Create mirror bootstrap logic.
- [ ] Add mirror refresh logic.
- [ ] Record last fetched revision and timestamps.
- [ ] Add corruption detection and rebuild path.

### Phase 4 — Session workspace materialization

Goal: create clean per-session workspaces from cache.

Checklist:

- [ ] Materialize a local session workspace from mirror.
- [ ] Check out requested ref.
- [ ] Record workspace metadata.
- [ ] Add cleanup on success/failure/cancel.
- [ ] Add janitor for stranded session workspaces.

### Phase 5 — AWS packaging

Goal: make the design deployable in ECS.

Checklist:

- [ ] Add EFS mount wiring for repo cache root.
- [ ] Add local workspace root wiring for task-local disk.
- [ ] Add S3 artifact config.
- [ ] Add IAM policy for artifact upload.
- [ ] Add CloudWatch metrics/dashboard for cache health.

## 13) Agent execution packets

These are intended as small units of work for agents or issue tickets.

### Packet A — Config and docs

Scope:

- config keys
- env vars
- docs only

Checklist:

- [ ] Add config schema entries.
- [ ] Add startup defaults.
- [ ] Add docs for local and AWS roots.
- [ ] Add tests for config resolution.

### Packet B — Repo registry

Scope:

- repository metadata
- lease metadata

Checklist:

- [ ] Add table/schema definitions.
- [ ] Add persistence adapter.
- [ ] Add repo lookup API.
- [ ] Add lease acquire/release tests.

### Packet C — Mirror lifecycle

Scope:

- create mirror
- refresh mirror
- recover mirror

Checklist:

- [ ] Implement mirror bootstrap.
- [ ] Implement refresh flow.
- [ ] Add metrics around refresh duration.
- [ ] Add rebuild path for corrupt mirrors.

### Packet D — Session workspace lifecycle

Scope:

- workspace materialization
- cleanup
- janitor

Checklist:

- [ ] Create local workspace from mirror.
- [ ] Track workspace metadata.
- [ ] Delete workspace after run.
- [ ] Add janitor for abandoned workspaces.

### Packet E — AWS infra

Scope:

- EFS
- ECS mount config
- S3 artifacts
- IAM

Checklist:

- [ ] Add Terraform inputs for repo cache root.
- [ ] Add Terraform inputs for session workspace root.
- [ ] Wire EFS mount.
- [ ] Wire artifact bucket config.
- [ ] Add IAM permissions.

## 14) Recommended near-term decisions

These should be explicitly decided before broad implementation starts:

- [ ] Use EFS for repo cache: yes/no
- [ ] Use local ephemeral disk for active sessions: yes/no
- [ ] Use bare mirror cache format: yes/no
- [ ] Use database-backed leases: yes/no
- [ ] Use S3 for artifacts: yes/no
- [ ] Define max cache size and eviction policy
- [ ] Define session workspace TTL

## 15) Non-goals for the first rollout

- Multi-region cache coherence
- Cross-account repo federation
- Perfect cache deduplication across all providers
- Full content-addressable storage
- Automatic archival of every session workspace

## 16) Suggested next step

Start with **Phase 1 + Packet A** and land only the config/storage-root contract first.

That gives the system a stable interface for:

- local development,
- ECS with EFS,
- future janitor and lease work,
- future migration from simple cache clone to mirror format.
