# Deployment

OpenMacaw includes AWS deployment scaffolding for the platform API and runtime
orchestrator services, plus the container-execution runtime stack used by
cloud-isolated coding runs.

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

## Self-Hosting AWS Quick Start

OpenMacaw can be used as the deploy source for an AWS environment, but the
public repository intentionally does not include private AWS account details.
At a high level, a self-hosted deploy looks like this:

1. Fork or clone OpenMacaw.
2. Create an AWS Terraform backend bucket and DynamoDB lock table.
3. Create or choose shared AWS infrastructure: VPC, subnets, ECS cluster,
   service discovery, and optionally ALB, Route53, CloudFront, S3, and EFS.
4. Create a GitHub OIDC deploy role scoped to the OpenMacaw repository or to a
   private deployment repository.
5. Store private deploy config JSON in AWS SSM as `SecureString` parameters.
6. Store runtime secrets in SSM or Secrets Manager and pass only ARNs in the
   deploy config.
7. Run the service deploy workflows manually, or call them from a private
   orchestration workflow.
8. Verify ECS service health, target groups, API health endpoints, and
   CloudWatch logs.

The OpenMacaw repo provides Terraform stacks, Docker build contexts, and
reusable GitHub Actions. The AWS account or private deployment repo provides
account IDs, domains, backend names, cluster names, service names, secret ARNs,
and production orchestration.

For a detailed walkthrough, see
[AWS deployment operations](aws-deployment-operations.md).

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
/openmacaw/dev/container-runtime/deploy/config
/openmacaw/prod/platform-api/deploy/config
/openmacaw/prod/runtime-orchestrator/deploy/config
/openmacaw/prod/container-runtime/deploy/config
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
- `infra/terraform/envs/example/container-execution/deploy-config.runtime.ssm.example.json`

## Deploy Workflows

The service workflows are available as manual/reusable building blocks:

- `.github/workflows/deploy-platform-api.yml`
- `.github/workflows/deploy-runtime-orchestrator.yml`
- `.github/workflows/deploy-container-runtime.yml`

They can be run manually through `workflow_dispatch` or called from a private
deployment repository with `workflow_call`. Keep environment-specific
orchestration, health checks, service names, cluster names, and notification
rules in the private deployment repository for that environment.

For third-party production deployments, the recommended model is:

- keep OpenMacaw generic and public;
- keep deploy config generation and SSM upload scripts in a private repository;
- keep any autonomous production workflow in that private repository;
- have the private workflow check out OpenMacaw at a known ref and call or
  reproduce the service deployment steps with private environment values.

Manual service workflow runs default to the `development` GitHub Environment
and the `dev` SSM path segment. For staging or production one-service deploys,
run the relevant service workflow manually and choose:

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
If `environment_slug=prod` or `deploy_config_param` contains `/prod/`, the
workflow forces the GitHub Environment to `production` so production approvals
and credentials are always used.

Each workflow:

1. reads backend and tfvars JSON from SSM
2. builds and pushes a service image when the workflow owns an image
3. runs `terraform init` with the temporary backend file
4. runs `terraform apply` with the temporary tfvars file
5. writes the deployed image URI pointer back to SSM when applicable

The container-runtime workflow does not build an image; it consumes the
executor image published by the container-executor image workflow and applies
the ECS task definition, task roles, and executor task security group. Its
post-apply smoke step can launch one Fargate task and require it to stop with
exit code `0`, matching the D2 acceptance check. The smoke task injects a
minimal executor request through `SYMPHONY_EXECUTION_REQUEST_JSON`, so it
proves the registered executor entrypoint can start successfully without
requiring a live coding session payload.

For the operational model around deploying OpenMacaw changes into an existing
AWS environment, see [AWS deployment operations](aws-deployment-operations.md).
