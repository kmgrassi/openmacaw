# Repo-Aware Infrastructure Reuse - Runtime Scope

## Goal

Reduce fanout startup cost by reusing existing runtime infrastructure
that already has the right repository materialized, while preserving
per-task workspace isolation.

Plainly: if a worker/container already has repo `R` cached and has
capacity, dispatch the next task for repo `R` there and create a fresh
isolated worktree/checkout for that task instead of cold-cloning the
repo somewhere else.

## Current State

Already present:

- `Workspace.create_for_issue/2` creates one isolated workspace per work
  item identifier.
- `Workspace.RepositoryBootstrap` can clone/copy a configured repository
  into newly created workspaces, but the direct path uses a shallow
  clone/copy per workspace.
- `WorkerBridge.RepositoryManager` already has a stronger cache model:
  durable bare mirror caches under a repo cache root, mirror locks, and
  per-session disposable workspaces cloned from the mirror.
- Runtime config already distinguishes `session_workspace_root` and
  `repo_cache_root`.
- `WorkerHostSelector` picks a worker host by capacity, but it is not
  repo-affinity aware.

Missing:

- No shared allocator that chooses a host/container based on repository
  cache locality.
- No reusable contract for "this host/container has repo R cached and
  can allocate one more isolated workspace."
- The orchestrator does not ask "where is this repo already warm?"
  before spawning a task.
- The generic workspace path does not prefer `git worktree` from a
  local bare mirror when safe.
- No visibility into cache hit/miss, checkout time, or why a warm host
  was not selected.

## Design Principles

- Reuse infrastructure, not mutable working directories.
- Every work item still gets its own isolated workspace path.
- Prefer warm repo cache locality only after hard safety gates pass:
  workspace concurrency cap, worker/container capacity, repository
  match, credential/resource access, and runner compatibility.
- Never run two unrelated tasks in the same working tree.
- A cache miss must still work through the cold path.
- Reuse must be observable: cache hit/miss, selected host/container,
  checkout path, and checkout duration.

## Proposed Behavior

For each dispatchable work item:

1. Resolve the canonical repository/resource set for the work item.
2. Ask a repo-aware allocator for eligible execution slots.
3. Prefer a running worker/container/host that:
   - is scoped to the same workspace or allowed resource boundary;
   - supports the requested runner kind and execution target;
   - has capacity under the workspace cap and host/container cap;
   - has the needed repo mirror/cache already present; and
   - can allocate a new isolated session workspace.
4. Allocate a fresh workspace for the work item:
   - preferred: `git worktree add` from a local bare mirror when the
     repository manager can support it safely;
   - acceptable v1: clone from the local bare mirror, preserving today's
     disposable workspace behavior;
   - fallback: cold clone/fetch when no warm cache exists.
5. Run the agent in that isolated workspace.
6. On terminal state, remove the per-task workspace while keeping the
   repo mirror/cache warm for future tasks.

## Non-Goals

- No sharing one mutable checkout across concurrent tasks.
- No cross-customer or cross-workspace cache sharing unless credentials
  and resource grants explicitly allow it.
- No changing the workspace concurrency cap; this scope consumes it.
- No long-lived agent session reuse in v1. This is infrastructure and
  repository cache reuse, not conversational thread reuse.
- No helper implementation unless a later local-helper scope wants to
  advertise repo-cache inventory.

## PR Plan

### PR 1 - Inventory and Capability Contract

- Define a runtime-internal capability shape for execution slots:
  `host/container id`, `workspace_id`, `runner_kinds`,
  `execution_target`, `available_slots`, `cached_repo_ids`, and
  `cache_state`.
- Add a repository identity helper that normalizes repo URL/resource
  metadata into a stable `repo_id`, reusing
  `WorkerBridge.RepositoryManager.repo_id/1` where possible.
- Document which slots are eligible for reuse and which are not.

Acceptance:

- Given a work item repository, runtime can compute the canonical
  `repo_id`.
- A slot with matching `repo_id` and capacity is marked eligible.
- A slot with wrong workspace, wrong runner kind, or no capacity is not
  eligible.

### PR 2 - Repo-Aware Host / Container Selection

- Extend selection after workspace-cap enforcement and before spawn.
- Prefer eligible warm slots over cold slots.
- Keep current least-loaded behavior as the tie-breaker.
- Preserve existing worker-host capacity behavior.
- Add skip/fallback reasons:
  - `warm_repo_slot_selected`
  - `repo_cache_miss`
  - `warm_repo_slot_full`
  - `runner_not_supported_on_warm_slot`

Acceptance:

- Two ready work items for the same repo prefer the same warm host when
  it has capacity.
- A full warm host is skipped and another eligible host is selected.
- No eligible warm host falls back to current cold behavior.

### PR 3 - Isolated Workspace From Warm Cache

- Promote the repository-manager cache path so orchestrator-created
  workspaces can use the same mirror/cache behavior as worker bridge
  sessions.
- Add an option to materialize a workspace via `git worktree add` from
  a mirror when supported.
- Keep clone-from-local-mirror as the fallback if worktree semantics are
  unsafe for a repository/ref combination.
- Record workspace metadata with repo id, cache path, ref, cache hit,
  materialization method, and checkout duration.

Acceptance:

- Creating two workspaces for the same repo uses one durable mirror and
  two isolated workspaces.
- Concurrent workspace creation serializes mirror updates but not
  independent checkout creation after the mirror is ready.
- Removing a workspace does not delete the durable repo cache.

### PR 4 - Container / Worker Reuse Policy

- Define when a running container/worker can accept another task:
  runner compatibility, workspace/customer boundary, credential/resource
  scope, disk capacity, and active session count.
- Add a reservation step so two dispatchers do not over-allocate the
  same warm slot.
- If multiple orchestrator processes can dispatch for the same
  workspace, use a shared reservation or route through a single
  workspace scheduler.

Acceptance:

- Reuse is denied across workspace/customer boundaries.
- Reuse is denied when the slot lacks required credentials/resources.
- Reservation prevents duplicate assignment under concurrent dispatch.

### PR 5 - Observability, Cleanup, and Smoke

- Emit structured events for cache hit/miss, selected slot, checkout
  method, checkout duration, and cleanup.
- Add a diagnostic view or CLI snapshot section showing warm repo caches
  and active isolated workspaces.
- Add smoke coverage:
  - create two work items for the same repo;
  - assert second dispatch uses the warm cache path;
  - assert each task has a distinct workspace path.

Acceptance:

- Operators can tell whether a task cold-cloned or reused a warm cache.
- Cleanup removes per-task workspaces and leaves the mirror/cache intact.
- Smoke proves two same-repo tasks do not share a mutable working tree.

## Runtime Files Likely Involved

- `apps/orchestrator/lib/symphony_elixir/orchestrator.ex`
- `apps/orchestrator/lib/symphony_elixir/orchestrator/worker_host_selector.ex`
- `apps/orchestrator/lib/symphony_elixir/workspace.ex`
- `apps/orchestrator/lib/symphony_elixir/workspace/repository_bootstrap.ex`
- `apps/orchestrator/lib/symphony_elixir/worker_bridge/repository_manager.ex`
- `apps/orchestrator/lib/symphony_elixir/config/schema.ex`
- `apps/orchestrator/test/symphony_elixir/workspace_and_config_test.exs`
- `apps/orchestrator/test/symphony_elixir/worker_bridge/repository_manager_test.exs`

## Open Questions

- Should v1 use `git worktree add` or keep clone-from-local-mirror as
  the first implementation? Recommendation: keep clone-from-local-mirror
  as the safe baseline, then add worktree materialization where tests
  prove it handles branch/ref isolation cleanly.
- Is the warm infrastructure unit a worker host, a long-lived container,
  or both? Recommendation: model a generic execution slot now and let
  worker-host/container adapters populate it.
- Do local helpers need to advertise repo-cache inventory? Recommendation:
  defer until helper capacity becomes a bottleneck; runtime cloud/worker
  reuse can land first.

## Definition of Done

- Runtime can prefer a warm repo slot without violating workspace,
  credential, runner, or capacity boundaries.
- Every task gets a distinct workspace path.
- Repo cache reuse is visible in logs/diagnostics.
- Cold path remains available and tested.
