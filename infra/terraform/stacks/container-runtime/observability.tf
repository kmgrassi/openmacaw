locals {
  container_execution_metric_namespace = "${var.project_name}/${var.environment}/container-execution"

  container_smoke_tests = {
    task_launch               = "Executor task starts, reaches RUNNING, exits successfully, and is observable by Runtime."
    log_split                 = "Executor non-error logs and error logs land in their configured destinations."
    egress_allow              = "Allowed egress destination is reachable from the executor network boundary."
    egress_deny               = "Denied egress destination is blocked by the executor network boundary."
    secret_injection          = "Allowed Secrets Manager or SSM value is readable only through the configured grant."
    sts_scope_positive        = "Scoped run credentials can write and read the current run artifact prefix."
    sts_scope_negative        = "Scoped run credentials cannot read or write another run or workspace prefix."
    vpc_endpoint_reachability = "Required AWS VPC endpoints are reachable without public NAT egress."
    queue_round_trip          = "Runtime queue/EventBridge round trip delivers a smoke event and receives acknowledgement."
    cancellation              = "Runtime cancellation stops the executor task and observes the terminal state."
    end_to_end                = "A coding run executes shell.exec and apply_patch, uploads artifacts, and reports completion."
  }

  container_smoke_environment = concat(
    [
      {
        name  = "CONTAINER_SMOKE_METRIC_NAMESPACE"
        value = local.container_execution_metric_namespace
      },
      {
        name  = "CONTAINER_SMOKE_TIMEOUT_MS"
        value = tostring(var.container_smoke_timeout_ms)
      }
    ],
    [
      for test_id, command in var.container_smoke_commands : {
        name  = "CONTAINER_SMOKE_${upper(test_id)}_COMMAND"
        value = command
      }
    ]
  )
}

resource "aws_iam_role" "container_smoke_events" {
  count = var.enable_container_smoke_schedule ? 1 : 0

  name = "${local.name_prefix}-container-smoke-events"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "events.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "container_smoke_events" {
  count = var.enable_container_smoke_schedule ? 1 : 0

  name = "${local.name_prefix}-container-smoke-events"
  role = aws_iam_role.container_smoke_events[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = aws_ecs_task_definition.executor.arn
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.ecs_cluster_arn
          }
        }
      },
      {
        Effect = "Allow"
        Action = "iam:PassRole"
        Resource = [
          aws_iam_role.executor_execution.arn,
          aws_iam_role.executor_task.arn,
        ]
      }
    ]
  })
}

resource "aws_iam_role_policy" "container_smoke_metrics" {
  count = var.enable_container_smoke_schedule ? 1 : 0

  name = "${local.name_prefix}-container-smoke-metrics"
  role = aws_iam_role.executor_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "cloudwatch:PutMetricData"
      Resource = "*"
      Condition = {
        StringEquals = {
          "cloudwatch:namespace" = local.container_execution_metric_namespace
        }
      }
    }]
  })
}

resource "aws_cloudwatch_event_rule" "container_smoke_schedule" {
  count = var.enable_container_smoke_schedule ? 1 : 0

  name                = "${local.name_prefix}-container-execution-smoke"
  description         = "Runs the container-execution smoke catalog on a fixed schedule."
  schedule_expression = var.container_smoke_schedule_expression
}

resource "aws_cloudwatch_event_target" "container_smoke_schedule" {
  count = var.enable_container_smoke_schedule ? 1 : 0

  rule     = aws_cloudwatch_event_rule.container_smoke_schedule[0].name
  arn      = var.ecs_cluster_arn
  role_arn = aws_iam_role.container_smoke_events[0].arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.executor.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    task_count          = 1

    network_configuration {
      subnets          = var.private_subnet_ids
      security_groups  = [aws_security_group.executor_tasks.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [
      {
        name        = var.executor_container_name
        command     = var.container_smoke_command
        environment = local.container_smoke_environment
      }
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "container_smoke_test_failures" {
  for_each = var.enable_container_smoke_schedule ? local.container_smoke_tests : {}

  alarm_name          = "${local.name_prefix}-container-smoke-${replace(each.key, "_", "-")}"
  alarm_description   = "Container execution smoke '${each.key}' failed. ${each.value}"
  namespace           = local.container_execution_metric_namespace
  metric_name         = "SmokeTestFailed"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    TestName = each.key
  }

  alarm_actions             = var.container_smoke_alarm_actions
  ok_actions                = var.container_smoke_ok_actions
  insufficient_data_actions = var.container_smoke_insufficient_data_actions
}
