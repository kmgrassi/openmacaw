output "service_url" {
  description = "Public URL of the OpenMacaw platform API"
  value       = "https://${var.domain_name}"
}

output "ecr_repository_url" {
  description = "ECR repository URL for pushing images"
  value       = aws_ecr_repository.app.repository_url
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.app.name
}

output "ecs_cluster_arn" {
  description = "ECS cluster ARN"
  value       = local.ecs_cluster_arn
}

output "task_definition_arn" {
  description = "Current task definition ARN"
  value       = aws_ecs_task_definition.app.arn
}

output "target_group_arn" {
  description = "ALB target group ARN"
  value       = aws_lb_target_group.app.arn
}

output "log_group_name" {
  description = "CloudWatch log group name"
  value       = aws_cloudwatch_log_group.app.name
}

output "observability_metric_namespace" {
  description = "CloudWatch custom metric namespace for platform API failure events"
  value       = local.observability_metric_namespace
}

output "observability_alarm_names" {
  description = "CloudWatch alarm names for platform API failure events"
  value       = [for alarm in aws_cloudwatch_metric_alarm.failure_events : alarm.alarm_name]
}
