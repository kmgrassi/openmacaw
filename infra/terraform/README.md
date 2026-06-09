# OpenMacaw Terraform

This directory contains Terraform entrypoints for deploying OpenMacaw to AWS.

The stacks were migrated from the previous Parallel Agent platform/runtime
deployments and sanitized so the public repo contains reusable infrastructure
and example configuration, not private account details.

## Layout

```text
infra/terraform/
  stacks/
    platform-api/                  # OpenMacaw platform API on ECS/Fargate
    container-execution-foundation/ # ECR, artifacts, and execution foundation
    container-runtime/             # ECS task definition/runtime launch support
    repository-cache/              # EFS-backed repository/session cache
    runtime-orchestrator/          # OpenMacaw runtime launcher/orchestrator
  envs/
    example/                       # backend/tfvars examples only
```

## Configuration Model

OpenMacaw keeps public defaults in this repo and reads private deployment values
from the deploying environment:

- GitHub secret: `AWS_DEPLOY_ROLE_ARN`
- AWS SSM parameter JSON for each deploy workflow
- Terraform remote state backend values supplied at deploy time
- Secrets passed as SSM/Secrets Manager ARNs, not plaintext values

Do not commit concrete `terraform.tfvars`, backend files, AWS account IDs,
domain names, or secret values for a private deployment.

## Deploy Model

The GitHub Actions deploy workflows build/push the relevant image to ECR, write
a temporary backend config and `tfvars` file from SSM, then run Terraform apply.

Recommended SSM parameters:

- `/openmacaw/dev/platform-api/deploy/config`
- `/openmacaw/dev/runtime-orchestrator/deploy/config`
- `/openmacaw/dev/container-runtime/deploy/config`
- `/openmacaw/prod/platform-api/deploy/config`
- `/openmacaw/prod/runtime-orchestrator/deploy/config`
- `/openmacaw/prod/container-runtime/deploy/config`

Push-triggered workflow runs default to the `dev` SSM path segment. Manual
workflow runs can select `dev`, `staging`, or `prod`, and can override the full
SSM parameter paths for private deployments with a different naming convention.

See the JSON examples in `envs/example/*/deploy-config*.ssm.example.json`.

## Manual Plan

For local/manual planning, copy one of the example backend and tfvars files:

```bash
cd infra/terraform/stacks/platform-api
terraform init -backend-config=../../envs/example/platform-api/backend.hcl.example
terraform plan -var-file=../../envs/example/platform-api/terraform.tfvars.example
```

Replace example values before applying.

## Container Runtime Deploy

The `container-runtime` stack is the D2 container-execution stack. It creates
the executor task definition, ECS task roles, executor task security group, and
the launch coordinates Runtime uses for `RunTask`.

The reusable deploy entrypoint is:

```bash
.github/workflows/deploy-container-runtime.yml
```

It reads SSM JSON from
`/openmacaw/<environment_slug>/container-runtime/deploy/config` by default,
runs Terraform apply for `stacks/container-runtime`, and can launch one smoke
task after apply. The smoke task waits for `STOPPED` and requires container
exit code `0`, which proves the configured cluster, task definition, ECR image,
subnets, security group, and task roles can run a task to completion.

Use
`envs/example/container-execution/deploy-config.runtime.ssm.example.json` as
the SSM shape for private dev/prod deployments.
