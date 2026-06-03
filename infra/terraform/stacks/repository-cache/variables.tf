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

variable "vpc_id" {
  description = "VPC where repository cache resources run"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets where EFS mount targets and cleanup tasks run"
  type        = list(string)
}

variable "execution_task_security_group_ids" {
  description = "Security group IDs for repository materialization/executor ECS tasks that need NFS access to the cache"
  type        = list(string)
  default     = []
}

variable "allowed_nfs_cidr_blocks" {
  description = "Optional CIDR blocks allowed to mount EFS over NFS; prefer execution_task_security_group_ids when possible"
  type        = list(string)
  default     = []
}

variable "efs_performance_mode" {
  description = "EFS performance mode for repository mirror caches"
  type        = string
  default     = "generalPurpose"
}

variable "efs_throughput_mode" {
  description = "EFS throughput mode for repository mirror caches"
  type        = string
  default     = "bursting"
}

variable "efs_provisioned_throughput_in_mibps" {
  description = "Provisioned throughput in MiB/s when efs_throughput_mode is provisioned"
  type        = number
  default     = null
}

variable "efs_transition_to_ia" {
  description = "Lifecycle transition for inactive EFS files"
  type        = string
  default     = "AFTER_30_DAYS"
}

variable "cache_posix_uid" {
  description = "POSIX uid used by executor tasks for repository mirror cache access"
  type        = number
  default     = 1000
}

variable "cache_posix_gid" {
  description = "POSIX gid used by executor tasks for repository mirror cache access"
  type        = number
  default     = 1000
}

variable "repository_cache_root" {
  description = "EFS access point path for bare repository mirror caches"
  type        = string
  default     = "/repository-cache"
}

variable "session_workspace_root" {
  description = "EFS access point path for warm session workspace leases"
  type        = string
  default     = "/session-workspaces"
}

variable "cleanup_image" {
  description = "Container image used by the scheduled cleanup task"
  type        = string
  default     = ""
}

variable "cleanup_container_name" {
  description = "Container name for the scheduled cleanup task"
  type        = string
  default     = "repository-cache-cleanup"
}

variable "cleanup_command" {
  description = "Command run by the cleanup task image"
  type        = list(string)
  default     = ["repository-cache-cleanup"]
}

variable "cleanup_task_cpu" {
  description = "Fargate CPU units for the cleanup task"
  type        = number
  default     = 256
}

variable "cleanup_task_memory" {
  description = "Fargate memory MiB for the cleanup task"
  type        = number
  default     = 512
}

variable "cleanup_schedule_expression" {
  description = "EventBridge schedule expression for repository cache cleanup"
  type        = string
  default     = "rate(1 hour)"
}

variable "enable_cleanup_schedule" {
  description = "Whether to create the scheduled ECS cleanup task"
  type        = bool
  default     = false
}

variable "ecs_cluster_arn" {
  description = "ECS cluster ARN where scheduled cleanup tasks should run"
  type        = string
  default     = ""
}

variable "cleanup_log_retention_days" {
  description = "CloudWatch log retention for repository cache cleanup task logs"
  type        = number
  default     = 30
}

variable "cleanup_failure_alarm_thresholds" {
  description = "Per-event cleanup failure counts over a five minute period that should trigger CloudWatch alarms"
  type        = map(number)
  default = {
    repository_cache_cleanup_failed      = 1
    repository_cache_lease_delete_failed = 1
    repository_cache_prune_failed        = 1
  }
}

variable "efs_burst_credit_balance_threshold" {
  description = "Alarm threshold for low EFS BurstCreditBalance"
  type        = number
  default     = 107374182400
}

variable "efs_percent_io_limit_threshold" {
  description = "Alarm threshold for high EFS PercentIOLimit"
  type        = number
  default     = 85
}

variable "alarm_actions" {
  description = "SNS topic ARNs or other CloudWatch alarm actions to invoke when alarms fire"
  type        = list(string)
  default     = []
}

variable "ok_actions" {
  description = "SNS topic ARNs or other CloudWatch alarm actions to invoke when alarms recover"
  type        = list(string)
  default     = []
}

variable "insufficient_data_actions" {
  description = "SNS topic ARNs or other CloudWatch alarm actions to invoke when alarms enter insufficient data"
  type        = list(string)
  default     = []
}
