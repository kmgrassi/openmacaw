output "cluster_id" {
  value = local.ecs_cluster_reference
}

output "cluster_name" {
  value = local.ecs_cluster_name
}

output "service_name" {
  value = aws_ecs_service.symphony.name
}

output "service_arn" {
  value = "arn:${data.aws_partition.current.partition}:ecs:${var.aws_region}:${data.aws_caller_identity.current.account_id}:service/${local.ecs_cluster_name}/${aws_ecs_service.symphony.name}"
}

output "task_definition_arn" {
  value = aws_ecs_task_definition.symphony.arn
}

output "task_execution_role_arn" {
  value = local.task_exec_role_arn
}

output "task_role_arn" {
  value = local.task_role_arn
}

# ALB-related outputs were removed along with the load balancer resources.
# The launcher is reached VPC-internally via ECS service discovery
# (openmacaw-launcher-dev.internal:4100 by default). A separate edge stack owns
# any public-edge outputs for production hostnames.
