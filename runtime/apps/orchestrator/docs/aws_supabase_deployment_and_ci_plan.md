# AWS + Supabase + GitHub Actions Lift Plan

This is the implementation plan that converts the existing ECS deployment approach into a concrete
Cloud-first workflow with:

- Symphony backend running in ECS Fargate
- Supabase-based authentication for the external React admin UI
- GitHub Actions build-and-deploy pipeline
- Optional remote execution via OpenClaw and SSH workers

## 1) Execution model

- Backend (orchestration + API): `symphony-orchestrator` service in ECS.
- Frontend: separate React project using:
  - `GET /api/v1/state`
  - `GET /api/v1/<issue_identifier>`
  - `POST /api/v1/refresh`
- AuthZ:
  - React app uses Supabase Auth and presents JWT/API key to Symphony API if required.
  - Backend validates/consumes Supabase metadata for operator identity flows.

## 2) CI/CD shape

Files added in this repo:

- `.github/workflows/deploy-aws.yml`
- `elixir/deploy/Dockerfile`
- `elixir/deploy/terraform/main.tf`
- `elixir/deploy/terraform/outputs.tf`
- `elixir/deploy/terraform/variables.tf`
- `elixir/deploy/terraform/environments/staging.tfvars.json`
- `elixir/deploy/terraform/environments/prod.tfvars.json`

Suggested pipeline:

1. Detect environment (`staging` from `main`, `production` from manual dispatch).
2. Authenticate to AWS with OIDC.
3. Build `elixir/deploy/Dockerfile` and push tag `${ENV}-${GITHUB_SHA}`.
4. Render environment tfvars (`staging` or `prod`) from `${ENV}.tfvars.json`.
5. Run Terraform plan/apply in `elixir/deploy/terraform`.

## 3) What is wired for Supabase

From this repo today:

- `supabase_url`, `supabase_anon_key`, `supabase_jwt_secret` are injected into container env in Terraform.
- `supabase_service_role_key_ssm_arn` is injected through ECS `secrets`.
- The backend can run with `auth_mode = supabase` in front-end docs without embedding auth keys in client code.

## 4) OpenClaw/remote worker readiness

- `openclaw_enabled` and `openclaw_*` inputs are already plumbed to container env through Terraform.
- Remote worker ping/readiness is expected to be implemented in runner/workspace layer:
  - SSH host ping command health checks.
  - OpenClaw health endpoint (`/v1/health`) checks before scheduling.
- Orchestrator remains the state authority; workers are just execution adapters.

## 5) Delivery milestones

### Milestone A: Foundation (1–2 weeks)

- Wire GitHub OIDC + ECR + Terraform init/apply.
- Add environment variables for Supabase auth in staging.
- Smoke test `/api/v1/state` from ECS task.

### Milestone B: Model/provider abstraction (2–3 weeks)

- Complete `SymphonyElixir.Runner` split (Codex + OpenClaw).
- Add provider field in workflow and route mapping.

### Milestone C: Operations hardening (1–2 weeks)

- Add CloudWatch dashboard/alarms around worker ping, error rate, retry queue length.
- Add manual prod approval boundary.
- Add ECR image pinning policy and rollback note in `deploy-aws.yml`.

## 6) Immediate follow-up

- Keep the frontend in a dedicated repository but consume the existing API contracts defined in
  `elixir/docs/react_frontend_integration.md`.
- Next commit should include environment-specific secrets and subnet IDs in GitHub Variables/Secrets.
