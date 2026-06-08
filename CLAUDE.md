# OpenMacaw — Agent Guide

Repo-level orientation for agents. Each subsystem has its own guide
(`platform/`, `runtime/`, `local-runtime-helper/` — see
[Subsystem guides](#subsystem-guides)); repo-wide docs live under `docs/`.

> `AGENTS.md` and `CLAUDE.md` at this level are kept in sync — edit both.

## Repository layout

- `platform/` — web app + API gateway + shared contracts (TypeScript)
- `runtime/` — Elixir orchestrator + launcher
- `local-runtime-helper/` — Go daemon for local model / tool relay
- `docs/` — cross-subsystem planning and reference material

## Local development

From the repo root: `./openmacaw run` starts the platform API (3100), web
(5173), runtime orchestrator (4000), and launcher (4100). Also
`./openmacaw doctor | status | stop`. See `README.md`.

## Production deployment — read this before deploying

OpenMacaw uses a **two-repo** production setup. Getting this wrong wastes
time (and triggers confusing AWS-credential failures), so:

- **`kmgrassi/OpenMacaw` (this repo, public)** — the source of truth for
  application code. PRs merge to `main` here.
- **`kmgrassi/OpenMacaw-kgprod` (private infra repo)** — owns the production
  deploy. Its `deploy-kg-production.yml` workflow is what actually ships to
  AWS.

### How prod deploys

1. `deploy-kg-production.yml` (in the infra repo) runs on a **`*/15 * * * *`
   schedule**, plus manual `workflow_dispatch` with an `openmacaw_ref` input
   (default `main`).
2. It resolves the target commit from `OpenMacaw@main` and **only deploys
   when `main` changed** under `platform/**`, `runtime/**`, the Supabase
   schema, the Terraform stacks, or the deploy workflows.
3. It builds and pushes the platform-api and runtime-orchestrator images
   **tagged with the OpenMacaw commit SHA**, runs Supabase migrations, and
   updates the ECS services (cluster `openmacaw-kgprod-cluster`; services
   `symphony-prod-server` for platform-api and `symphony-orchestrator-prod`
   for the runtime).
4. It authenticates to AWS via **GitHub OIDC**, assuming `OpenMacawDeployRole`
   under the infra repo's `production` GitHub Environment.

### What this means for you

- **Merging to `main` here is enough to ship to prod.** The 15-minute cron
  picks it up automatically — typically live within ~15 minutes of merge. No
  manual deploy step is required.
- **Do NOT run `deploy-platform-api.yml` or `deploy-runtime-orchestrator.yml`
  directly from this repo.** `OpenMacawDeployRole`'s OIDC trust only allows
  `repo:kmgrassi/OpenMacaw-kgprod:environment:production`. A `workflow_dispatch`
  of those workflows from `kmgrassi/OpenMacaw` fails at the AWS-credentials step
  ("Could not load credentials from any providers") — `AWS_DEPLOY_ROLE_ARN`
  isn't set here, and the role wouldn't trust this repo anyway. Those workflows
  are reusable building blocks the infra repo drives; the real entry point is
  `deploy-kg-production.yml` in `OpenMacaw-kgprod`.
- **To check what's live**, compare the deployed image SHA to
  `git rev-parse origin/main`. The running ECS task's image tag — and the SSM
  `image-uri` pointers the infra repo reads — is the deployed OpenMacaw commit
  SHA.
- **To force a deploy** (e.g. to redeploy without a new commit), run it from
  the infra repo:
  `gh workflow run deploy-kg-production.yml --repo kmgrassi/OpenMacaw-kgprod -f openmacaw_ref=main`
  (requires access to the private repo).

> These files are in the **public** repo. Per
> [`docs/open-source-readiness-scope.md`](docs/open-source-readiness-scope.md),
> do not add raw AWS account IDs, secret/role ARNs, internal hostnames, or SSM
> parameter paths here — keep those in the private `OpenMacaw-kgprod` repo,
> which holds the exact ARNs, parameter paths, and health-check URLs.

## Subsystem guides

- Platform (TypeScript): [`platform/AGENTS.md`](platform/AGENTS.md) /
  [`platform/CLAUDE.md`](platform/CLAUDE.md)
- Runtime (Elixir): [`runtime/AGENTS.md`](runtime/AGENTS.md) /
  [`runtime/CLAUDE.md`](runtime/CLAUDE.md)
- Local helper (Go): [`local-runtime-helper/AGENTS.md`](local-runtime-helper/AGENTS.md) /
  [`local-runtime-helper/CLAUDE.md`](local-runtime-helper/CLAUDE.md)
