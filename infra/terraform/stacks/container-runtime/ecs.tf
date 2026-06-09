resource "aws_cloudwatch_log_group" "executor" {
  name              = "/aws/ecs/${local.name_prefix}/container-executor"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "executor" {
  family                   = "${local.name_prefix}-container-executor"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.executor_cpu
  memory                   = var.executor_memory
  execution_role_arn       = aws_iam_role.executor_execution.arn
  task_role_arn            = aws_iam_role.executor_task.arn

  ephemeral_storage {
    size_in_gib = var.executor_ephemeral_storage_gib
  }

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    merge(
      {
        name        = var.executor_container_name
        image       = local.executor_image
        essential   = true
        stopTimeout = var.executor_stop_timeout_seconds

        environment = [
          { name = "EXECUTION_ADAPTER", value = "aws_ecs" },
          { name = "WORKSPACE_ROOT", value = var.workspace_root },
          { name = "RESOURCE_ROOT", value = var.resource_root },
          { name = "ARTIFACT_BUCKET", value = local.artifact_bucket_name },
          { name = "ARTIFACT_PREFIX_ROOT", value = local.artifact_prefix_root },
          { name = "ARTIFACT_PREFIX", value = local.artifact_write_prefix },
          { name = "NETWORK_POLICY_JSON", value = var.network_policy_json },
        ]

        logConfiguration = {
          logDriver = "awslogs"
          options = {
            "awslogs-group"         = aws_cloudwatch_log_group.executor.name
            "awslogs-region"        = var.aws_region
            "awslogs-stream-prefix" = "executor"
          }
        }
      },
      length(var.executor_command) > 0 ? { command = var.executor_command } : {}
    )
  ])
}
