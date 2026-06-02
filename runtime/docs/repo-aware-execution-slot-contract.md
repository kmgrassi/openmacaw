# Repo-Aware Execution Slot Contract

Runtime repo-cache reuse is modeled as an execution slot. A slot can be a
worker host, container, or future runtime unit that can accept one or more
isolated task workspaces.

## Shape

- `id`: stable host/container/runtime slot id.
- `workspace_id`: workspace boundary the slot is allowed to serve.
- `runner_kinds`: runner kinds supported by the slot.
- `execution_target`: target family, such as a worker host or container.
- `available_slots`: number of additional isolated workspaces the slot can
  accept now.
- `cached_repo_ids`: canonical repository ids already warm on the slot.
- `cache_state`: slot-local cache metadata for diagnostics and later ranking.

Repository ids are computed with `SymphonyElixir.RepositoryIdentity`, which
uses the worker bridge repository manager id contract for Git URLs and local
paths.

## Eligibility

A slot is eligible for warm reuse only when all of these are true:

- The slot `workspace_id` matches the work item workspace.
- The requested runner kind is present in `runner_kinds`.
- The requested execution target equals the slot `execution_target`.
- `available_slots` is greater than zero.
- The requested canonical `repo_id` is present in `cached_repo_ids`.

Any mismatch is ineligible. A cache miss is not an error; later selection work
falls back to the existing cold path when no warm slot is eligible.
