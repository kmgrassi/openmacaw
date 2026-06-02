output "executor_task_definition_arn" {
  description = "ECS task definition ARN Runtime should launch for container execution"
  value       = aws_ecs_task_definition.executor.arn
}

output "executor_task_role_arn" {
  description = "Task role ARN assigned to running executor containers"
  value       = aws_iam_role.executor_task.arn
}

output "executor_execution_role_arn" {
  description = "Task execution role ARN used by ECS to pull images and write logs"
  value       = aws_iam_role.executor_execution.arn
}

output "executor_security_group_id" {
  description = "Security group ID Runtime should attach to executor tasks"
  value       = aws_security_group.executor_tasks.id
}

output "executor_private_subnet_ids" {
  description = "Private subnet IDs Runtime should use for executor task placement"
  value       = var.private_subnet_ids
}

output "executor_cluster_arn" {
  description = "ECS cluster ARN where Runtime launches executor tasks"
  value       = var.ecs_cluster_arn
}

output "executor_container_name" {
  description = "Executor container name used for command overrides and status inspection"
  value       = var.executor_container_name
}

output "artifact_bucket_name" {
  description = "S3 bucket where executor tasks write durable run artifacts"
  value       = aws_s3_bucket.artifacts.bucket
}

output "artifact_prefix_root" {
  description = "Top-level S3 prefix under which executor artifacts are written"
  value       = local.artifact_prefix_root
}

output "artifact_write_prefix" {
  description = "S3 prefix this MVP executor task role can write"
  value       = local.artifact_write_prefix
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch log group for executor lifecycle logs"
  value       = aws_cloudwatch_log_group.executor.name
}
