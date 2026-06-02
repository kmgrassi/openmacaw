<p align="center">
  <img src="docs/assets/openmacaw-logo.png" alt="OpenMacaw logo" width="180">
</p>

# OpenMacaw

OpenMacaw is an open-source platform for coordinating AI agents across hosted
and local runtimes. This repository combines the web/API platform, the runtime
orchestrator, and the installable local helper into one source tree.

OpenMacaw is currently pre-release. The repository has been imported from
separate internal projects and still needs public documentation, naming,
security, licensing, and self-hosting cleanup before it should be treated as a
polished open-source launch.

## What is in this repo

- `platform/` contains the web app, API gateway, shared contracts, platform
  scripts, and generated Supabase types.
- `runtime/` contains the Elixir runtime/orchestrator, launcher, relay-facing
  runtime behavior, worker bridge, smoke tools, and generated runtime schema
  artifacts.
- `local-runtime-helper/` contains the Go daemon that connects a user's machine
  to supported local runners and the runtime relay.
- `docs/` contains OpenMacaw-level planning and reference material that applies
  across the imported subsystems.

The repository starts from a clean import rather than preserving the private
commit histories of the source repositories. Local environment files, git
metadata, dependency caches, generated build output, Terraform working
directories, compiled binaries, and runtime logs were intentionally excluded
from the initial import.

## How the pieces fit together

At a high level:

1. The platform provides the browser UI, API surface, shared contracts, and
   database-backed coordination layer.
2. The runtime launches and supervises agent work, reads routable work items,
   runs manager/planner flows, and exposes launcher/worker bridge APIs.
3. The local runtime helper runs on a user's machine, opens an outbound relay
   connection, advertises configured local runners, and can execute supported
   local workflows without requiring inbound network access.

Some workflows can be developed inside one subsystem. Full end-to-end behavior
requires the platform, runtime, helper, provider credentials, and a configured
Supabase/database path.

## Current status

OpenMacaw is not yet ready for a public self-hosting announcement.

Known launch-readiness work includes:

- replacing private/internal naming and stale prototype language;
- adding license, contribution, security, issue, and PR policy files;
- documenting a minimal local setup and a full self-hosted Supabase path;
- defining a stable root command surface for install, dev, doctor, validation,
  tests, build, logs, and smoke checks;
- documenting the local execution trust model and credential handling;
- scrubbing public docs for private URLs, account IDs, local paths, and
  internal process references;
- adding CI and release guidance suitable for outside contributors.

See [docs/open-source-readiness-scope.md](docs/open-source-readiness-scope.md)
for the current readiness plan and PR breakdown.

## Local development

Start the local OpenMacaw stack from the repository root:

```sh
./openmacaw run
```

That command checks the required command-line tools, installs missing
JavaScript and Elixir dependencies, then starts the platform API, platform web
app, runtime launcher, and runtime orchestrator together.

When the stack is ready, the command prints the local URLs and log paths:

- Web: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:3100`
- Runtime orchestrator: `http://127.0.0.1:4000`
- Runtime launcher: `http://127.0.0.1:4100`

Press `Ctrl+C` to stop the stack.

Useful root commands:

```sh
./openmacaw doctor
./openmacaw status
./openmacaw stop
```

Linked git worktrees automatically use an offset port range so multiple agents
can run OpenMacaw side by side. Override ports with `API_PORT`, `WEB_PORT`,
`ORCHESTRATOR_PORT`, or `LAUNCHER_PORT` when needed.

The local runtime helper remains a separate daemon for workflows that need
local model or local tool execution. Configure it from `local-runtime-helper/`
after the core stack is running.

Some workflows still require local services, environment variables, provider
credentials, or a configured Supabase/database path. The open-source readiness
work will keep narrowing those prerequisites and making them explicit.

## Documentation

Start with [docs/README.md](docs/README.md) for repository-level documentation
and the current readiness plan.

The imported subsystem docs are useful but not all of them have been rewritten
for public OpenMacaw context yet. Treat historical planning docs, private repo
links, old project names, and internal deployment notes as cleanup targets until
the readiness work is complete.
