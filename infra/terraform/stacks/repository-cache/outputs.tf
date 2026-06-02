output "repository_cache_file_system_id" {
  description = "EFS file system ID for repository mirror caches and warm session workspaces"
  value       = aws_efs_file_system.repository_cache.id
}

output "repository_cache_file_system_arn" {
  description = "EFS file system ARN for repository mirror caches and warm session workspaces"
  value       = aws_efs_file_system.repository_cache.arn
}

output "repository_cache_security_group_id" {
  description = "Security group ID attached to repository cache EFS mount targets"
  value       = aws_security_group.repository_cache_efs.id
}

output "repository_mirrors_access_point_id" {
  description = "EFS access point ID for bare repository mirror caches"
  value       = aws_efs_access_point.repository_mirrors.id
}

output "session_workspaces_access_point_id" {
  description = "EFS access point ID for warm session workspace leases"
  value       = aws_efs_access_point.session_workspaces.id
}

output "executor_efs_volumes" {
  description = "ECS task definition volume blocks expected by executor tasks that use the repository cache"
  value = {
    repository_mirrors = {
      name                 = "repository-mirrors"
      file_system_id       = aws_efs_file_system.repository_cache.id
      access_point_id      = aws_efs_access_point.repository_mirrors.id
      transit_encryption   = "ENABLED"
      container_mount_path = "/workspace/.cache/repository-mirrors"
      read_only            = false
    }
    session_workspaces = {
      name                 = "session-workspaces"
      file_system_id       = aws_efs_file_system.repository_cache.id
      access_point_id      = aws_efs_access_point.session_workspaces.id
      transit_encryption   = "ENABLED"
      container_mount_path = "/workspace/sessions"
      read_only            = false
    }
  }
}

output "cleanup_task_definition_arn" {
  description = "Scheduled cleanup ECS task definition ARN when cleanup scheduling is enabled"
  value       = local.create_cleanup_resources ? aws_ecs_task_definition.cleanup[0].arn : null
}

output "cleanup_schedule_rule_name" {
  description = "EventBridge rule name for repository cache cleanup when cleanup scheduling is enabled"
  value       = local.create_cleanup_resources ? aws_cloudwatch_event_rule.cleanup[0].name : null
}

output "observability_metric_namespace" {
  description = "CloudWatch custom metric namespace for repository cache cleanup and cache health"
  value       = local.observability_metric_namespace
}

output "observability_alarm_names" {
  description = "CloudWatch alarm names for repository cache and cleanup health"
  value = compact(concat(
    [aws_cloudwatch_metric_alarm.efs_low_burst_credits.alarm_name],
    [aws_cloudwatch_metric_alarm.efs_high_io_limit.alarm_name],
    [for alarm in aws_cloudwatch_metric_alarm.cleanup_failure_events : alarm.alarm_name],
    local.create_cleanup_resources ? [aws_cloudwatch_metric_alarm.cleanup_schedule_failed_invocations[0].alarm_name] : [],
  ))
}
