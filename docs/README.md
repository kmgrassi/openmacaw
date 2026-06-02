# OpenMacaw Docs

This directory holds OpenMacaw-level documentation: material that applies to
the combined platform, runtime, and local helper repository.

## Start here

- [Open source readiness scope](open-source-readiness-scope.md) defines the
  remaining work to make OpenMacaw understandable, runnable, auditable, and
  maintainable for external developers and self-hosters.

## Subsystem docs

The imported subsystems still keep most of their original documentation in
their own directories:

- `platform/docs/` for platform/API/web contracts, runbooks, active scopes, and
  generated schema guidance.
- `runtime/docs/` and `runtime/apps/orchestrator/docs/` for runtime,
  orchestrator, launcher, relay, smoke, and scheduling docs.
- `local-runtime-helper/docs/` for helper install, runtime config, relay, and
  local runner docs.

Those docs have not all been rewritten for public OpenMacaw context. When a
document still refers to old repository names, private GitHub URLs, Harper-only
infrastructure, or stale prototype status, treat that as part of the open-source
readiness cleanup rather than as the final public position.

## Documentation lifecycle

Use repository-level docs for durable cross-subsystem guidance. Keep
subsystem-specific implementation details next to the subsystem they describe.

Historical planning documents can remain useful, but public entrypoints should
link to stable reference docs before linking to active scopes, shipped PR
plans, or superseded material.
