# AWS Deployment Operations

This document describes how to use OpenMacaw as the deploy source for an
existing AWS environment.

The goal is:

- OpenMacaw source changes merge to `main`.
- GitHub Actions builds the changed service image.
- GitHub Actions assumes a deploy role through OIDC.
- The workflow reads private environment config from AWS SSM.
- Terraform applies only the OpenMacaw service stack.
- Existing shared AWS infrastructure remains owned by the existing platform
  stack or by explicit SSM-provided values.

## Deployment Model

OpenMacaw should be the application deployment source of truth, not the place
where private AWS account configuration is committed.

The repository owns:

- Dockerfiles and service build contexts.
- Terraform modules/stacks for OpenMacaw services.
- GitHub Actions deploy workflows.
- Public example SSM config shapes.

The AWS account owns:

- concrete account IDs;
- Terraform state bucket and lock table;
- VPC, subnet, ALB, Route53, ECS cluster, and shared platform values;
- private domains;
- Supabase keys and other secrets;
- SSM parameter values used by deploy workflows.

## What Deploys On OpenMacaw Updates

There are currently two service deploy workflows:

- `.github/workflows/deploy-platform-api.yml`
- `.github/workflows/deploy-runtime-orchestrator.yml`

When a PR merges to `main`, GitHub Actions evaluates path filters:

- Changes under `platform/**` or `infra/terraform/stacks/platform-api/**`
  deploy the platform API stack.
- Changes under `runtime/**` or
  `infra/terraform/stacks/runtime-orchestrator/**` deploy the runtime
  launcher/orchestrator stack.

Both workflows can also be run manually through `workflow_dispatch`.

Each workflow:

1. checks out OpenMacaw;
2. assumes `AWS_DEPLOY_ROLE_ARN` through GitHub OIDC;
3. reads deploy config JSON from SSM;
4. writes temporary Terraform backend and tfvars files on the runner;
5. builds and pushes an image tagged with the commit SHA and `main`;
6. runs `terraform init`;
7. runs `terraform apply`;
8. writes the deployed image URI back to SSM.

## Existing Infrastructure Contract

Before OpenMacaw can deploy into an existing AWS environment, that environment
must provide one of the following:

- shared platform Terraform state containing VPC, subnet, ALB, and ECS cluster
  outputs; or
- explicit VPC, subnet, ALB, listener, security group, and ECS cluster values in
  the service deploy config.

The existing infrastructure should keep owning:

- public edge routing and ALB listener policy, unless the OpenMacaw stack is
  explicitly configured to manage its own public edge;
- shared VPC/subnets;
- shared ECS cluster;
- shared Terraform backend bucket and lock table;
- DNS zones and private hosted zones;
- AWS account-wide IAM baseline.

OpenMacaw service stacks should own:

- service-specific ECR repositories/images;
- service-specific ECS task definitions and services;
- service-specific CloudWatch log groups/alarms;
- service-specific IAM task roles where not supplied;
- service-specific security groups;
- service-specific Cloud Map registration for internal runtime discovery.

## Required GitHub Configuration

Create a GitHub Environment for each deploy environment, such as
`development`, `staging`, and `production`.

For each environment, set:

```text
AWS_DEPLOY_ROLE_ARN=arn:aws:iam::<account-id>:role/<github-oidc-deploy-role>
```

The deploy role should trust this repository through GitHub OIDC and should be
scoped to:

- read SSM deploy config parameters;
- read/write the Terraform backend and lock table;
- manage OpenMacaw ECR repositories and images;
- apply the specific OpenMacaw Terraform stacks;
- write deployed image URI SSM pointer parameters;
- read secret parameters referenced by ECS task definitions where needed.

## Required AWS SSM Parameters

The current workflow defaults use:

```text
/openmacaw/dev/platform-api/deploy/config
/openmacaw/dev/platform-api/deploy/image-uri
/openmacaw/dev/runtime-orchestrator/deploy/config
/openmacaw/dev/runtime-orchestrator/deploy/image-uri
```

For staging/production, use the same shape with environment-specific paths, then
update workflow environment variables or add environment-aware workflow inputs.

The deploy config parameter contains:

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

Use the example files in `infra/terraform/envs/example/` as the source shape.
The real SSM JSON should include all required stack variables for the target
environment.

## Platform API Deploy Contract

The platform API workflow deploys `platform/apps/api` into the
`infra/terraform/stacks/platform-api` stack.

The deploy config must provide:

- Terraform backend config;
- `project_name`;
- `environment`;
- AWS region;
- runtime/orchestrator URL;
- launcher URL;
- CORS origins for the web client;
- Supabase URL;
- service-role-key SSM ARN when server-side Supabase access is required;
- either shared platform state pointers or explicit VPC/subnet/ALB/ECS values.

For existing infrastructure, prefer:

```json
{
  "shared_platform_state_enabled": true,
  "shared_platform_state_bucket": "YOUR_SHARED_PLATFORM_STATE_BUCKET",
  "shared_platform_state_key": "openmacaw/shared/terraform.tfstate",
  "shared_platform_state_region": "us-east-1",
  "manage_public_edge": false
}
```

That lets the existing shared platform own public edge infrastructure while
OpenMacaw owns the platform API service deployment.

## Runtime Orchestrator Deploy Contract

The runtime workflow deploys `runtime/apps/orchestrator` into the
`infra/terraform/stacks/runtime-orchestrator` stack.

The deploy config must provide:

- Terraform backend config;
- `project_name`;
- `environment_name`;
- service name;
- ECR repository name/URI;
- image tag, supplied by the workflow;
- shared platform state pointers or explicit VPC/subnet/ECS values;
- Supabase URL, anon key, JWT secret, and service-role-key SSM ARN as needed;
- Cloud Map service discovery values for VPC-internal API-to-launcher routing;
- EFS workspace mount values when persistent runtime workspaces are enabled.

For existing infrastructure, prefer:

```json
{
  "shared_platform_state_enabled": true,
  "create_ecs_cluster": false,
  "existing_ecs_cluster_name": "openmacaw-dev",
  "service_discovery_namespace": "openmacaw-dev.local",
  "service_discovery_service_name": "openmacaw-launcher-dev"
}
```

The platform API should then point at the runtime through the private DNS name,
for example:

```text
http://openmacaw-launcher-dev.openmacaw-dev.local:4100
```

## Recommended Rollout Flow

1. Merge OpenMacaw changes to `main`.
2. Let path-filtered deploy workflows run automatically.
3. Watch GitHub Actions for build, image push, and Terraform apply status.
4. Check ECS service deployment health.
5. Check CloudWatch logs for service startup.
6. Check API health:

```sh
curl https://<api-domain>/livez
```

7. Check runtime/launcher health from inside the VPC or through the platform API
   path that proxies runtime health.
8. Confirm the SSM image URI pointer was updated to the commit SHA image.

## Manual Deploy Flow

Use manual dispatch when:

- replaying a failed deploy;
- deploying after SSM config changes;
- deploying Terraform-only changes;
- deploying an environment not tied directly to `main`.

From GitHub Actions, run:

- `Deploy Platform API`
- `Deploy Runtime Orchestrator`

The workflow uses the commit selected by the manual run and the configured SSM
deploy config path.

## Migration From Existing Harper-Owned Infrastructure

For an existing Harper-owned AWS environment:

1. Keep the existing Terraform backend/state bucket and lock table private.
2. Keep existing VPC, ECS cluster, ALB, DNS, and private service-discovery
   details in shared Terraform state or SSM deploy config.
3. Point OpenMacaw workflows at those values through SSM.
4. Decide which resources OpenMacaw should adopt and which should remain owned
   by the existing shared stack.
5. If adopting an existing AWS resource into an OpenMacaw Terraform stack,
   import it or use Terraform moved/removed blocks intentionally. Do not let a
   first OpenMacaw apply recreate shared production resources.
6. Deploy development first, then staging/production.

## What Still Needs To Be Added

- Environment-aware deploy inputs for `dev`, `staging`, and `prod` rather than
  only hard-coded `dev` SSM paths.
- A separate public web client deploy workflow, if the web client is deployed
  outside the platform API.
- A one-time checklist for importing/adopting existing AWS resources into the
  OpenMacaw Terraform stacks.
- Post-deploy smoke checks that run automatically after Terraform apply.
- A rollback playbook that pins ECS services back to a previous image URI.
