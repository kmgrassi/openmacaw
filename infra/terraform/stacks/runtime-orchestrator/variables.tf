variable "aws_region" {
  description = "AWS region for the deployment."
  type        = string
}

variable "project_name" {
  description = "Logical name for this deployment."
  type        = string
}

variable "environment_name" {
  description = "Deployment environment name."
  type        = string
}

variable "shared_platform_state_enabled" {
  description = "Read shared platform outputs from Terraform remote state."
  type        = bool
  default     = false
}

variable "shared_platform_state_bucket" {
  description = "S3 bucket containing shared platform Terraform state."
  type        = string
  default     = ""
}

variable "shared_platform_state_key" {
  description = "State key for shared platform Terraform state."
  type        = string
  default     = ""
}

variable "shared_platform_state_region" {
  description = "Region for the shared platform Terraform state bucket."
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "VPC ID for ECS tasks and optional ALB. Leave empty to use shared platform state."
  type        = string
  default     = ""
}

variable "public_subnets" {
  description = "Public subnet IDs."
  type        = list(string)
  default     = []
}

variable "private_subnets" {
  description = "Private subnet IDs for ECS Fargate tasks."
  type        = list(string)
  default     = []
}

variable "create_ecs_cluster" {
  description = "Create a dedicated ECS cluster. Disable to reuse an existing shared cluster."
  type        = bool
  default     = true
}

variable "ecs_cluster_name" {
  type        = string
  description = "Name of the ECS cluster to create."
  default     = ""
}

variable "existing_ecs_cluster_name" {
  type        = string
  description = "Existing ECS cluster name or ARN. Used when create_ecs_cluster is false."
  default     = ""
}

variable "service_name" {
  type        = string
  description = "ECS service name."
}

variable "ecr_repository_name" {
  type        = string
  description = "ECR repository used by the pipeline."
}

variable "ecr_repository_uri" {
  type        = string
  description = "Full ECR repository URI."
}

variable "image_tag" {
  type        = string
  description = "Image tag pushed in CI."
}

variable "task_cpu" {
  type    = number
  default = 1024
}

variable "task_memory" {
  type    = number
  default = 2048
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "container_port" {
  type    = number
  default = 4100
}

variable "relay_socket_port" {
  type        = number
  default     = 0
  description = "Port the launcher serves the local-relay WebSocket on. 0 disables the relay socket (env var, port mapping, and SG ingress are all omitted)."
}

variable "relay_target_group_name" {
  type        = string
  default     = ""
  description = "Name of an ALB target group, owned by a separate edge stack, to register the relay socket port into. Empty disables the load-balancer attachment."
}

variable "target_group_port" {
  description = "Default ALB target group port. ECS awsvpc services register task IPs with the container port, so existing deployments can keep this stable to avoid target group replacement."
  type        = number
  default     = 4100
}

variable "container_command" {
  description = "Entrypoint args passed to the OpenMacaw runtime process."
  type        = list(string)
  default     = ["launcher", "--port", "4100", "--state-dir", "/tmp/openmacaw/launcher", "--workflow", "/app/elixir/WORKFLOW.md"]
}

variable "health_check_path" {
  description = "HTTP path used by the ALB target group to health check the container."
  type        = string
  default     = "/health"
}

variable "container_environment" {
  description = "Key/value environment vars for the container (not secrets)."
  type        = map(string)
  default     = {}
}

variable "container_secrets" {
  description = "Name -> SSM ARN map for container secrets."
  type        = map(string)
  default     = {}
}

variable "task_execution_role_arn" {
  description = "Optional pre-existing ECS execution role ARN. If unset, Terraform creates a role."
  type        = string
  default     = ""
}

variable "task_role_arn" {
  description = "Optional pre-existing ECS task role ARN. If unset, Terraform creates a role."
  type        = string
  default     = ""
}

variable "secretsmanager_secret_arns" {
  description = "Secrets Manager secret ARNs the launcher task may read for Supabase-backed credential secret_ref values."
  type        = list(string)
  default     = []
}

variable "secretsmanager_kms_key_arns" {
  description = "Optional KMS key ARNs needed to decrypt Secrets Manager values that use customer-managed keys."
  type        = list(string)
  default     = []
}

variable "autoscaling_enabled" {
  description = "Enable ECS service autoscaling."
  type        = bool
  default     = true
}

variable "autoscaling_min" {
  description = "Minimum desired task count when autoscaling."
  type        = number
  default     = 1
}

variable "autoscaling_max" {
  description = "Maximum desired task count when autoscaling."
  type        = number
  default     = 4
}

variable "autoscaling_target_cpu" {
  description = "Target average CPU utilization for autoscaling."
  type        = number
  default     = 60
}

variable "autoscaling_scale_out_cooldown" {
  description = "Scale-out cooldown in seconds."
  type        = number
  default     = 60
}

variable "autoscaling_scale_in_cooldown" {
  description = "Scale-in cooldown in seconds."
  type        = number
  default     = 300
}

variable "logs_root" {
  description = "Deprecated. Kept for compatibility with older orchestrator deploy configs; launcher mode uses LAUNCHER_STATE_DIR instead."
  type        = string
  default     = "/var/log/openmacaw"
}

# ALB-related variables were removed. This module no longer manages any
# load balancer, listener, listener rule, or target group. Any public
# routing for public hostnames should be owned by a separate edge stack.
# The launcher is reached VPC-internally via ECS service discovery,
# configured below.

variable "service_discovery_namespace" {
  description = "Cloud Map private-DNS namespace to register the launcher in. Must already exist. Leave empty to skip service-discovery registration."
  type        = string
  default     = ""
}

variable "service_discovery_service_name" {
  description = "Service name (first DNS label) under `service_discovery_namespace` for the launcher. Final DNS is `<this>.<namespace>`."
  type        = string
  default     = "openmacaw-launcher-dev"
}

variable "domain_name" {
  description = "DNS record for service, if managed outside of Terraform."
  type        = string
  default     = ""
}

variable "enable_efs" {
  description = "Use EFS to persist workspaces."
  type        = bool
  default     = true

  validation {
    condition     = !var.enable_efs || (var.efs_file_system_id != "" && var.efs_access_point_id != "")
    error_message = "When enable_efs is true, both efs_file_system_id and efs_access_point_id must be set."
  }
}

variable "efs_file_system_id" {
  type    = string
  default = ""
}

variable "efs_access_point_id" {
  type    = string
  default = ""
}

variable "workspace_mount_path" {
  description = "Container workspace mount path."
  type        = string
  default     = "/tmp/openmacaw_workspaces"
}

variable "workspace_volume_name" {
  type    = string
  default = "openmacaw_workspaces"
}

variable "openclaw_enabled" {
  description = "Whether to expose OpenClaw variables in worker configuration."
  type        = bool
  default     = false
}

variable "openclaw_base_url" {
  description = "Base URL for remote OpenClaw endpoint."
  type        = string
  default     = ""
}

variable "openclaw_api_version" {
  description = "OpenClaw API version string."
  type        = string
  default     = "v1"
}

variable "openclaw_request_timeout_ms" {
  description = "Request timeout in milliseconds for OpenClaw health/run calls."
  type        = number
  default     = 30000
}

variable "openclaw_max_concurrent_runs" {
  description = "Max concurrent OpenClaw runs."
  type        = number
  default     = 2
}

variable "supabase_url" {
  description = "Supabase project URL used by the orchestration/auth stack."
  type        = string
  default     = ""
}

variable "supabase_anon_key" {
  description = "Supabase anonymous public key."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_jwt_secret" {
  description = "Supabase JWT secret used for token validation."
  type        = string
  default     = ""
  sensitive   = true
}

variable "supabase_service_role_key_ssm_arn" {
  description = "Optional SSM ARN for Supabase service-role key."
  type        = string
  default     = ""
}
