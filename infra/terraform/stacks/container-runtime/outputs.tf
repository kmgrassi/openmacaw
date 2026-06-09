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
  value       = local.artifact_bucket_name
}

output "artifact_prefix_root" {
  description = "Top-level S3 prefix under which executor artifacts are written"
  value       = local.artifact_prefix_root
}

output "artifact_write_prefix" {
  description = "S3 prefix this MVP executor task role can write"
  value       = local.artifact_write_prefix
}

output "per_run_artifact_session_policy_template" {
  description = "STS session policy template Runtime fills with artifact_bucket_arn and artifact_prefix for each run"
  value       = local.per_run_artifact_session_policy_template
}

output "container_secret_kms_key_arn" {
  description = "KMS key ARN used to encrypt container execution secrets"
  value       = aws_kms_key.container_secrets.arn
}

output "container_secret_path_root" {
  description = "Secrets Manager path root for container execution secrets"
  value       = local.secret_path_root
}

output "container_smoke_secret_arn" {
  description = "Smoke-test secret ARN used to verify in-scope secret reads"
  value       = aws_secretsmanager_secret.smoke.arn
}

output "executor_lifecycle_state_machine_arn" {
  description = "Step Functions state machine ARN Runtime should call instead of raw ECS RunTask"
  value       = aws_sfn_state_machine.executor_lifecycle.arn
}

output "executor_network_firewall_arn" {
  description = "AWS Network Firewall ARN enforcing executor egress policy"
  value       = aws_networkfirewall_firewall.executor_egress.arn
}

output "executor_network_firewall_policy_arn" {
  description = "AWS Network Firewall policy ARN for executor egress"
  value       = aws_networkfirewall_firewall_policy.executor_egress.arn
}

output "executor_network_firewall_allowed_domains" {
  description = "FQDN allowlist enforced for executor egress"
  value       = var.network_firewall_allowed_domains
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch log group for executor lifecycle logs"
  value       = aws_cloudwatch_log_group.executor.name
}

output "container_smoke_alarm_names" {
  description = "CloudWatch alarm names keyed by container smoke test id"
  value       = { for key, alarm in aws_cloudwatch_metric_alarm.container_smoke_test_failures : key => alarm.alarm_name }
}

output "container_smoke_schedule_rule_name" {
  description = "EventBridge rule name for the scheduled container smoke catalog"
  value       = var.enable_container_smoke_schedule ? aws_cloudwatch_event_rule.container_smoke_schedule[0].name : null
}
