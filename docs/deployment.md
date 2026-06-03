# Deployment

OpenMacaw now includes the initial AWS deployment scaffold migrated from the
previous Parallel Agent platform/runtime deployments.

The repo contains reusable Terraform stacks and deploy workflows, but it does
not contain private account configuration. Keep AWS account IDs, backend
buckets, domain names, and secrets in GitHub secrets and AWS SSM parameters.

## Terraform Layout

```text
infra/terraform/
  stacks/
    platform-api/
    container-execution-foundation/
    container-runtime/
    repository-cache/
    runtime-orchestrator/
  envs/example/
```

The public examples in `infra/terraform/envs/example` document the expected
shape for backend config, local `tfvars`, and SSM deploy config JSON.

## GitHub Secrets

Set this repository secret:

```text
AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<github-oidc-deploy-role>
```

The role should trust GitHub OIDC for this repo and have permission to:

- read the deploy config SSM parameters
- manage ECR repositories/images used by OpenMacaw
- read/write the configured Terraform backend
- apply the resources in the selected Terraform stack
- write the deployed image pointer SSM parameters

## SSM Deploy Config

The deploy workflows read JSON from SSM:

```text
/openmacaw/dev/platform-api/deploy/config
/openmacaw/dev/runtime-orchestrator/deploy/config
/openmacaw/prod/platform-api/deploy/config
/openmacaw/prod/runtime-orchestrator/deploy/config
```

Use `SecureString` for deploy config parameters when the JSON contains any
sensitive Terraform values. Prefer passing runtime secrets as SSM/Secrets
Manager ARNs through `container_secrets` rather than embedding plaintext values
in the deploy config JSON.

Each parameter should contain:

```json
{
  "terraform_backend": {
    "bucket": "YOUR_TERRAFORM_STATE_BUCKET",
    "key": "openmacaw/dev/platform-api/terraform.tfstate",
    "region": "us-east-1",
    "dynamodb_table": "YOUR_TERRAFORM_LOCK_TABLE",
    "encrypt": true
  },
  "terraform_vars": {
    "project_name": "openmacaw",
    "environment": "dev"
  }
}
```

Use the fuller examples in:

- `infra/terraform/envs/example/platform-api/deploy-config.ssm.example.json`
- `infra/terraform/envs/example/platform-api/deploy-config.production.ssm.example.json`
- `infra/terraform/envs/example/runtime-orchestrator/deploy-config.ssm.example.json`
- `infra/terraform/envs/example/runtime-orchestrator/deploy-config.production.ssm.example.json`
- `infra/terraform/envs/example/openclaw-instance/deploy-config.ssm.example.json`

## Deploy Workflows

Two workflows deploy on pushes to `main` that touch their service or Terraform
stack:

- `.github/workflows/deploy-platform-api.yml`
- `.github/workflows/deploy-runtime-orchestrator.yml`

They can also be run manually through `workflow_dispatch`.

Push-triggered deploys use the `development` GitHub Environment and the `dev`
SSM path segment by default. For staging or production, run the workflow
manually and choose:

```text
deploy_environment=production
environment_slug=prod
```

That resolves the default production SSM paths:

```text
/openmacaw/prod/platform-api/deploy/config
/openmacaw/prod/platform-api/deploy/image-uri
/openmacaw/prod/runtime-orchestrator/deploy/config
/openmacaw/prod/runtime-orchestrator/deploy/image-uri
```

For private deployments that use a different naming convention, provide
`deploy_config_param` and `image_uri_param` in the manual workflow run.

OpenMacaw also includes an experimental `Deploy OpenClaw Instance` workflow for
running an existing OpenClaw broker/gateway deployment from OpenMacaw. It is
manual-only by design. Start with `apply=false` and point its SSM config at the
existing OpenClaw Terraform backend/state so Terraform plans against the already
managed resources rather than trying to recreate them.

Each workflow:

1. reads backend and tfvars JSON from SSM
2. builds the service image
3. pushes `:<commit-sha>` and `:main` tags to ECR
4. runs `terraform init` with the temporary backend file
5. runs `terraform apply` with the temporary tfvars file
6. writes the deployed image URI pointer back to SSM

For the operational model around deploying OpenMacaw changes into an existing
AWS environment, see [AWS deployment operations](aws-deployment-operations.md).

## Harper Deployment Values

For Harper-owned AWS environments, keep the concrete values in SSM instead of
committing `tfvars` files. That lets OpenMacaw remain the deploy source of truth
while keeping private infrastructure details private.
