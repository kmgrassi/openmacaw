# Contributing to OpenMacaw

OpenMacaw is pre-release. The repository is being prepared for public
open-source use, so contributor workflows may change as the platform,
runtime, and local helper are consolidated.

## Before opening a PR

1. Read [README.md](README.md) and
   [docs/open-source-readiness-scope.md](docs/open-source-readiness-scope.md).
2. Keep changes scoped to one subsystem or one cross-subsystem contract.
3. Separate broad refactors from feature behavior when possible.
4. Do not add backwards-compatibility aliases for old internal names unless a
   real rollout constraint requires them.
5. Do not commit secrets, local `.env` files, generated logs, dependency
   caches, compiled binaries, Terraform working directories, or local runtime
   state.

## Repository layout

- `platform/` contains the web app, API gateway, shared contracts, platform
  scripts, and generated Supabase types.
- `runtime/` contains the orchestrator, launcher, worker bridge, relay-facing
  runtime behavior, manager/planner execution, and smoke tooling.
- `local-runtime-helper/` contains the installable Go daemon for local runner
  connectivity and machine diagnostics.
- `docs/` contains OpenMacaw-level docs that apply across subsystems.

## Validation

There is not yet one root validation command. Use the smallest validation set
that covers the files you changed.

For platform changes:

```sh
cd platform
pnpm install
pnpm run doctor
```

For runtime script or orchestrator changes:

```sh
cd runtime
pnpm install
pnpm run doctor:runtime
```

For Elixir runtime code changes:

```sh
cd runtime/apps/orchestrator
mix compile --warnings-as-errors
mix test
```

For local helper changes:

```sh
cd local-runtime-helper
go build ./...
go vet ./...
go test ./...
```

If a command requires unavailable services or credentials, note that in the PR
and run the closest local/unit validation instead.

## Generated files and contracts

Generated schema and contract artifacts should be updated only through their
documented generation commands. Do not hand-edit generated Supabase types or
schema artifacts.

Cross-subsystem contract changes should land deliberately. Update the contract
definition, its generated/derived artifacts, and the affected platform/runtime
helper behavior together when the contract is shared.

## Documentation

Public entrypoints should link to stable reference docs before linking to
active scopes, shipped PR plans, or superseded material. If you find private
repo links, absolute local paths, stale internal naming, or inaccessible setup
instructions, either clean them up in the current PR when local to the change
or call them out as follow-up.

## Pull request checklist

- The PR has one primary purpose.
- Public docs avoid private URLs, account IDs, local paths, and real
  credentials.
- Validation commands and results are listed in the PR body.
- Generated files are either untouched or regenerated through documented
  commands.
- Security-sensitive changes explain credential, logging, and local execution
  implications.
