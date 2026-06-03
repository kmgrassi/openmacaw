locals {
  worker_default_cluster_name = local.platform_ecs_cluster != null && startswith(local.platform_ecs_cluster, "arn:") ? element(split("/", local.platform_ecs_cluster), 1) : local.platform_ecs_cluster

  worker_gateway_container = {
    name      = "gateway"
    image     = var.gateway_image
    essential = true
    command   = ["sh", "-lc", "node openclaw.mjs models set ${var.openclaw_model} && node openclaw.mjs gateway --allow-unconfigured --bind lan"]
    environment = [
      {
        name  = "OPENCLAW_STATE_DIR"
        value = "/var/openclaw-state"
      },
      {
        name  = "OPENCLAW_SERVICE_NAME"
        value = "gateway-worker-default"
      },
      {
        name  = "OPENCLAW_IMAGE_URI"
        value = var.gateway_image
      },
      {
        name  = "OPENCLAW_DEPLOY_RUN_ID"
        value = var.deploy_run_id
      },
      {
        name  = "OPENCLAW_MODEL"
        value = var.openclaw_model
      },
      {
        name  = "OPENCLAW_BROKER_BASE_URL"
        value = var.openclaw_broker_base_url
      },
      {
        name  = "OPENCLAW_CONTROL_UI_ALLOWED_ORIGINS"
        value = var.openclaw_control_ui_allowed_origins
      },
      {
        name  = "OPENCLAW_GATEWAY_CONTROL_UI_ALLOWED_ORIGINS"
        value = var.openclaw_control_ui_allowed_origins
      },
      {
        name = "OPENCLAW_JSON"
        value = jsonencode({
          gateway = {
            controlUi = {
              allowedOrigins                           = [for o in split(",", var.openclaw_control_ui_allowed_origins) : trimspace(o) if trimspace(o) != ""]
              dangerouslyAllowHostHeaderOriginFallback = true
            }
          }
        })
      }
    ]
    secrets = concat(
      [
        {
          name      = "OPENCLAW_GATEWAY_PASSWORD"
          valueFrom = var.openclaw_gateway_password_secret_arn
        }
      ],
      var.openclaw_broker_bearer_secret_arn != null ? [
        {
          name      = "OPENCLAW_BROKER_BEARER"
          valueFrom = var.openclaw_broker_bearer_secret_arn
        }
      ] : [],
      local.gateway_provider_secret_bindings
    )
    mountPoints = [
      {
        sourceVolume  = "openclaw_state"
        containerPath = "/var/openclaw-state"
        readOnly      = false
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.gateway_worker_default.name
        awslogs-region        = var.aws_region
        awslogs-stream-prefix = "ecs"
      }
    }
  }

  worker_default_container = merge(
    {
      name      = "worker"
      image     = var.worker_default_image
      essential = true
      dependsOn = [
        {
          containerName = "gateway"
          condition     = "START"
        }
      ]
      environment = [
        {
          name  = "QUEUE_URL"
          value = aws_sqs_queue.default.id
        },
        {
          name  = "ARTIFACTS_BUCKET"
          value = aws_s3_bucket.artifacts.bucket
        },
        {
          name  = "OPENCLAW_GATEWAY_URL"
          value = "http://127.0.0.1:18789"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker_default.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    },
    length(var.worker_default_command) > 0 ? { command = var.worker_default_command } : {}
  )
}

resource "aws_cloudwatch_log_group" "worker_default" {
  name              = "/ecs/openclaw-worker-default-dev"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "gateway_worker_default" {
  name              = "/ecs/openclaw-gateway-worker-default-dev"
  retention_in_days = 14
}

resource "aws_security_group" "worker_default_service" {
  name        = "openclaw-worker-default-service-dev"
  description = "Security group for default worker ECS service"
  vpc_id      = local.platform_vpc_id

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "ecs_task_execution_worker_default" {
  name = "openclaw-ecs-task-execution-worker-default-dev"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_worker_default_base" {
  role       = aws_iam_role.ecs_task_execution_worker_default.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_worker_default_secrets" {
  statement {
    sid = "ReadWorkerGatewaySecrets"
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = local.ecs_execution_secret_allow_arns
  }
}

resource "aws_iam_policy" "ecs_task_execution_worker_default_secrets" {
  name   = "openclaw-ecs-task-execution-worker-default-secrets-dev"
  policy = data.aws_iam_policy_document.ecs_task_execution_worker_default_secrets.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_worker_default_secrets" {
  role       = aws_iam_role.ecs_task_execution_worker_default.name
  policy_arn = aws_iam_policy.ecs_task_execution_worker_default_secrets.arn
}

resource "aws_iam_role" "ecs_task_worker_default" {
  name = "openclaw-ecs-task-worker-default-dev"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com"
        },
        Action = "sts:AssumeRole"
      }
    ]
  })
}

data "aws_iam_policy_document" "ecs_task_worker_default" {
  statement {
    sid = "SqsConsumeDefaultQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl"
    ]
    resources = [
      aws_sqs_queue.default.arn
    ]
  }

  statement {
    sid = "ArtifactsS3RW"
    actions = [
      "s3:ListBucket"
    ]
    resources = [
      aws_s3_bucket.artifacts.arn
    ]
  }

  statement {
    sid = "ArtifactsS3ObjectRW"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject"
    ]
    resources = [
      "${aws_s3_bucket.artifacts.arn}/*"
    ]
  }
}

resource "aws_iam_policy" "ecs_task_worker_default" {
  name   = "openclaw-ecs-task-worker-default-dev"
  policy = data.aws_iam_policy_document.ecs_task_worker_default.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_worker_default" {
  role       = aws_iam_role.ecs_task_worker_default.name
  policy_arn = aws_iam_policy.ecs_task_worker_default.arn
}

resource "aws_ecs_task_definition" "openclaw_worker_default" {
  family                   = "openclaw-worker-default-dev"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_default_task_cpu
  memory                   = var.worker_default_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution_worker_default.arn
  task_role_arn            = aws_iam_role.ecs_task_worker_default.arn

  container_definitions = jsonencode([
    local.worker_gateway_container,
    local.worker_default_container
  ])

  volume {
    name = "openclaw_state"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.openclaw_state.id
      transit_encryption = "ENABLED"

      authorization_config {
        access_point_id = aws_efs_access_point.openclaw_state.id
        iam             = "DISABLED"
      }
    }
  }
}

resource "aws_ecs_service" "openclaw_worker_default" {
  name            = "openclaw-worker-default-dev"
  cluster         = local.platform_ecs_cluster
  task_definition = aws_ecs_task_definition.openclaw_worker_default.arn
  desired_count   = var.worker_default_desired_count
  launch_type     = "FARGATE"

  depends_on = [aws_efs_mount_target.openclaw_state]

  lifecycle {
    precondition {
      condition     = local.worker_default_cluster_name != null && local.worker_default_cluster_name != ""
      error_message = "ECS cluster name/ARN is missing. Set ecs_cluster var or ensure shared platform state exposes ecs_cluster_arn/ecs_cluster_name."
    }
  }

  network_configuration {
    subnets          = local.platform_private_subnet_ids
    security_groups  = [aws_security_group.worker_default_service.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_appautoscaling_target" "worker_default" {
  max_capacity       = var.worker_default_max_count
  min_capacity       = var.worker_default_min_count
  resource_id        = "service/${local.worker_default_cluster_name}/${aws_ecs_service.openclaw_worker_default.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_default_scale_out" {
  name               = "openclaw-worker-default-scale-out-dev"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.worker_default.resource_id
  scalable_dimension = aws_appautoscaling_target.worker_default.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
  }
}

resource "aws_appautoscaling_policy" "worker_default_scale_in" {
  name               = "openclaw-worker-default-scale-in-dev"
  service_namespace  = "ecs"
  resource_id        = aws_appautoscaling_target.worker_default.resource_id
  scalable_dimension = aws_appautoscaling_target.worker_default.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 120
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_default_queue_scale_out" {
  alarm_name          = "openclaw-worker-default-queue-scale-out-dev"
  alarm_description   = "Scale out default worker when queue depth increases"
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Average"
  threshold           = var.worker_default_scale_out_messages
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = aws_sqs_queue.default.name
  }
  alarm_actions = [aws_appautoscaling_policy.worker_default_scale_out.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_default_queue_scale_in" {
  alarm_name          = "openclaw-worker-default-queue-scale-in-dev"
  alarm_description   = "Scale in default worker when queue is empty"
  comparison_operator = "LessThanOrEqualToThreshold"
  evaluation_periods  = 10
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Average"
  threshold           = var.worker_default_scale_in_messages
  treat_missing_data  = "notBreaching"
  dimensions = {
    QueueName = aws_sqs_queue.default.name
  }
  alarm_actions = [aws_appautoscaling_policy.worker_default_scale_in.arn]
}

output "worker_default_service_name" {
  value = aws_ecs_service.openclaw_worker_default.name
}
