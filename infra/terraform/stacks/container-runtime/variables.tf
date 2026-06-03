variable "project_name" {
  description = "Project identifier used in resource naming"
  type        = string
  default     = "openmacaw"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "foundation_state_bucket" {
  description = "S3 bucket containing the container execution foundation Terraform state"
  type        = string
}

variable "foundation_state_key" {
  description = "S3 key containing the container execution foundation Terraform state"
  type        = string
}

variable "foundation_state_region" {
  description = "AWS region for the container execution foundation Terraform state"
  type        = string
  default     = "us-east-1"
}

variable "ecs_cluster_arn" {
  description = "ECS cluster ARN where Runtime launches executor tasks"
  type        = string
}

variable "vpc_id" {
  description = "VPC where executor tasks run"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for Fargate executor task placement"
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) > 0
    error_message = "private_subnet_ids must include at least one subnet."
  }
}

variable "executor_image_tag" {
  description = "Container executor image tag deployed from the foundation ECR repository"
  type        = string
  default     = "main"
}

variable "executor_container_name" {
  description = "Name of the executor container in the ECS task definition"
  type        = string
  default     = "container-executor"
}

variable "executor_command" {
  description = "Optional command override for the executor container image"
  type        = list(string)
  default     = []
}

variable "executor_cpu" {
  description = "Fargate task CPU units for executor tasks"
  type        = number
  default     = 512
}

variable "executor_memory" {
  description = "Fargate task memory in MiB for executor tasks"
  type        = number
  default     = 1024
}

variable "executor_ephemeral_storage_gib" {
  description = "Task-local ephemeral storage size for repository checkouts"
  type        = number
  default     = 21

  validation {
    condition     = var.executor_ephemeral_storage_gib >= 21 && var.executor_ephemeral_storage_gib <= 200
    error_message = "executor_ephemeral_storage_gib must be between 21 and 200 GiB."
  }
}

variable "workspace_root" {
  description = "Task-local root where resources are materialized"
  type        = string
  default     = "/workspace"
}

variable "resource_root" {
  description = "Task-local directory where repository aliases are materialized"
  type        = string
  default     = "/workspace/resources"
}

variable "artifact_prefix_root" {
  description = "Top-level S3 prefix under which run artifacts are written"
  type        = string
  default     = "workspaces"
}

variable "artifact_workspace_id" {
  description = "Workspace ID segment for the MVP artifact write prefix"
  type        = string
  default     = "dev-smoke-workspace"
}

variable "artifact_run_id" {
  description = "Run ID segment for the MVP artifact write prefix"
  type        = string
  default     = "dev-smoke-run"
}

variable "log_retention_days" {
  description = "CloudWatch log retention period for executor lifecycle logs"
  type        = number
  default     = 30
}

variable "allowed_secret_arns" {
  description = "Secrets Manager or SSM parameter ARNs the executor task may read for resource credentials"
  type        = list(string)
  default     = []
}

variable "egress_cidr_blocks" {
  description = "CIDR blocks executor tasks may reach over HTTPS for Git providers, Runtime callbacks, and AWS service endpoints"
  type        = list(string)
  default     = []
}

variable "network_policy_json" {
  description = "Cloud-neutral network policy JSON passed to the executor for adapter enforcement/audit"
  type        = string
  default     = "{}"
}
