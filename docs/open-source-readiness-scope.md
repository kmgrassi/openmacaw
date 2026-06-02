# Open Source Readiness Scope

Status: draft.

This scope consolidates the open-source readiness plans from the imported
platform, runtime, and local runtime helper repositories. OpenMacaw should be
treated as one public project with three major subsystems, not three unrelated
repos copied into one directory.

## Summary of what needs to be built

OpenMacaw needs to become understandable, runnable, auditable, and maintainable
for external developers and self-hosters.

The target state is:

1. A new user can land on the repo, understand what OpenMacaw does, and see how
   `platform/`, `runtime/`, and `local-runtime-helper/` work together.
2. A contributor can install dependencies, run the smallest useful local stack,
   run validation, and know which workflows require optional services.
3. A self-hoster can set up the required Supabase/database path from public
   docs without private Harper infrastructure or hidden scripts.
4. A security-conscious user can understand what executes locally, what talks
   to cloud services, what credentials are used, and what gets logged.
5. Public docs, scripts, examples, and workflows do not depend on private
   domains, private GitHub URLs, absolute local paths, internal process docs,
   private account IDs, or real credentials.
6. The repo has the basic legal, governance, contribution, security, CI, and
   release files expected by open-source consumers.

The imported subsystem boundaries should stay clear:

- `platform/` owns the web app, API gateway, shared contracts, platform
  scripts, and generated Supabase types.
- `runtime/` owns the orchestrator, launcher, runtime relay behavior, manager
  and planner execution, smoke tooling, and generated runtime schema artifacts.
- `local-runtime-helper/` owns the installable local daemon, local runner
  config, relay connection, local tool execution, and machine diagnostics.

## Shared/foundational work to land first

### Public project identity

Settle the public name, repository owner path, package naming posture, and
status language before rewriting broad documentation. This avoids repeating
old names like `parallel-agent-*`, stale `Symphony` framing, or Harper-specific
cloud assumptions throughout the public docs.

### Repository-level docs and navigation

Create a root README and docs landing page that explain the system once, then
link into subsystem-specific docs. This should land before app-level README
rewrites so each subsystem can point back to a stable project narrative.

### Open-source hygiene rules

Define the scrub policy before doing detailed cleanup:

- no real secrets or copied local `.env` files;
- no absolute local filesystem paths;
- no private domains, project refs, account IDs, or credential-bearing URLs;
- no private owner/repo links required for setup;
- no generated logs, local runtime state, support bundles, dependency caches,
  build output, Terraform working directories, or compiled binaries.

This should include root ignore rules and a repeatable publish-readiness scan.

### Environment and self-hosting contract

Document the data and auth model before feature docs. Public users need a clear
split between:

- hosted/managed-service users, who should not need service-role or migration
  setup; and
- open-source self-hosters, who need a reproducible Supabase project setup,
  versioned migrations or a public schema package, generated types, auth
  settings, and provider credentials.

The current imported projects assume migrations are owned outside the platform
repo. OpenMacaw needs either a public migration source or a documented schema
package before self-hosting docs can be considered complete.

### Script and validation contract

Define one public command surface at the repo root before polishing individual
scripts. The common target should include install, dev/start, doctor, validate,
test, build, logs, and smoke commands, with subsystem-specific commands
documented behind that surface.

### Security and local execution model

The helper executes local work and the runtime handles credentials and agent
actions. Before launch, document trust boundaries, token handling, secret
redaction, workspace access, local tool execution, outbound relay behavior, and
what data can leave the machine.

## Numbered PR breakdown

1. **Root public entrypoint and repo map**

   Introduce a root README and docs index for OpenMacaw. Explain the product,
   subsystem layout, minimum local path, full-stack path, known limitations,
   and where to find durable docs. Keep this focused on public navigation, not
   deep app rewrites.

   Verification: docs review plus link checks where available.

2. **Project identity and metadata cleanup**

   Replace top-level public-facing references to old repo names, stale
   `Symphony` prototype language, Harper-only framing, and private owner paths
   where they affect first-run docs, package metadata, installer URLs, release
   URLs, or public support links.

   Verification: targeted `rg` scans for old names, private owners, absolute
   paths, and inaccessible setup links.

3. **Governance, legal, and support files**

   Add `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, optional
   `CODE_OF_CONDUCT.md`, issue templates, PR template, and package metadata
   updates. Include validation expectations, generated-file policy, docs
   lifecycle, vulnerability reporting, and support boundaries.

   Verification: docs review and package metadata check.

4. **Environment and self-hosting setup**

   Create a minimal root env path and advanced configuration reference. Clarify
   Supabase setup, migration ownership, generated schema artifacts, model
   provider keys, local model options, and which workflows require platform,
   runtime, helper, Ollama, or external services.

   Verification: run the documented `doctor` or preflight command once the
   command exists; otherwise validate all env examples are placeholder-only.

5. **Script inventory and public command surface**

   Add or document root commands for install, dev/start, doctor, validate,
   test, build, logs, and smoke checks. Group specialized scripts as smoke,
   diagnostics, generated artifacts, maintenance, or internal/deployment-only.
   Ensure public scripts fail with actionable messages and do not print
   secrets.

   Verification: run documented root validation commands that do not require
   private services; add targeted tests for script helpers where practical.

6. **Subsystem documentation refresh**

   Rewrite or update subsystem docs around public user paths:

   - `platform/`: app/API docs, local development, scripts, troubleshooting,
     self-hosting, generated Supabase types.
   - `runtime/`: root runtime narrative, orchestrator setup, launcher/relay
     behavior, smoke tools, stale prototype language cleanup.
   - `local-runtime-helper/`: install, configuration, runners,
     troubleshooting, architecture, release path, and daemon trust model.

   Verification: docs review, link checks, and subsystem-specific validation
   where docs touch runnable commands.

7. **Security, privacy, and publish audit**

   Run and document a repeatable open-source audit for secrets, private
   infrastructure, logs, fixtures, generated artifacts, dependency licenses,
   installer behavior, local execution risk, and release artifacts.

   Verification: committed checklist with scan commands and recorded results
   for the initial public-readiness pass.

8. **CI and release readiness**

   Add public CI workflows that run the same checks expected of contributors.
   Decide whether the first public release is source-only, package artifacts,
   container images, helper binaries, or some combination. Document versioning,
   release notes, generated artifact checks, dependency scanning, and optional
   artifact signing/provenance.

   Verification: CI dry run or local equivalent for the required checks.

9. **Cross-repo contract consolidation**

   Replace private planning links with stable public contracts. Document relay
   frames, runner kinds, execution profiles, credential shapes, database schema
   ownership, generated type refresh, and drift detection. Avoid adding
   backward-compatibility aliases solely for old internal names.

   Verification: contract tests or documented generated-artifact checks.

## Follow-up work

- Package manager distribution for the helper, such as Homebrew or Linux
  packages. This is useful but should not block a source-first launch.
- Hosted demo or managed cloud onboarding. The first public pass should make
  local/self-hosted behavior clear before promising a hosted service.
- Broad architecture refactors to make the repo smaller. The first launch
  should prioritize clarity, security, and repeatable setup over reshaping the
  system.
- Rich example apps and templates. Add these after the minimum local stack and
  security model are documented.
- Long-term protocol stability guarantees. For the first public release, it is
  acceptable to state pre-1.0 expectations while making current contracts
  explicit.

## Open questions

- What license should OpenMacaw use?
- Is the first public release fully open source with outside PR intake, or
  source-available first with contribution intake enabled later?
- Which old names should be preserved as historical context, and which should
  be fully renamed before launch?
- Where should public database migrations live in OpenMacaw?
- Are internal AWS deployment docs part of the public launch, or should public
  deployment docs focus on local/self-hosted setup first?
- Should package names remain internal workspace names, move to an OpenMacaw
  namespace, or stay private until packages are published?
- What local tool execution policy is acceptable by default: model-only,
  workspace tools opt-in, or current behavior with strong warnings?
