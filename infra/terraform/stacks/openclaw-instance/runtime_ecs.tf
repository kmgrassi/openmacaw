locals {
  platform_private_subnet_ids = length(lookup(local.platform_outputs, "private_subnet_ids", [])) > 0 ? lookup(local.platform_outputs, "private_subnet_ids", []) : (
    length(lookup(local.platform_outputs, "private_subnets", [])) > 0 ? lookup(local.platform_outputs, "private_subnets", []) : var.private_subnet_ids
  )
  platform_alb_security_group_id = lookup(local.platform_outputs, "alb_security_group_id", lookup(local.platform_outputs, "alb_sg_id", var.alb_security_group_id))
  platform_ecs_cluster = lookup(local.platform_outputs, "ecs_cluster_arn", null) != null ? lookup(local.platform_outputs, "ecs_cluster_arn", null) : (
    lookup(local.platform_outputs, "ecs_cluster_name", null) != null ? lookup(local.platform_outputs, "ecs_cluster_name", null) : var.ecs_cluster
  )

  broker_container = merge(
    {
      name      = "broker"
      image     = var.broker_image
      essential = true
      portMappings = [
        {
          containerPort = var.broker_target_group_port
          protocol      = "tcp"
        }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.broker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
      environment = [
        {
          name  = "OPENCLAW_SERVICE_NAME"
          value = "broker"
        },
        {
          name  = "OPENCLAW_IMAGE_URI"
          value = var.broker_image
        },
        # Deploy run id is intentionally injected so each deploy has a traceable runtime fingerprint.
        {
          name  = "OPENCLAW_DEPLOY_RUN_ID"
          value = var.deploy_run_id
        },
        {
          name  = "OPENCLAW_GATEWAY_URL"
          value = "http://${var.gateway_discovery_service_name}.${var.gateway_discovery_namespace_name}:18789"
        },
        {
          name  = "OPENCLAW_GATEWAY_PROTOCOL"
          value = var.openclaw_gateway_protocol
        },
        {
          name  = "OPENCLAW_ENGINE_CLIENT_ID"
          value = "gateway-client"
        },
        {
          name  = "OPENCLAW_ENGINE_CLIENT_MODE"
          value = "backend"
        },
        {
          name  = "OPENCLAW_ALLOWED_ORIGINS"
          value = var.openclaw_control_ui_allowed_origins
        },
        {
          name  = "OPENCLAW_GATEWAY_WS_ORIGIN"
          value = var.openclaw_gateway_ws_origin
        },
        {
          name  = "OPENCLAW_SUPABASE_URL"
          value = var.openclaw_supabase_url
        },
        {
          name  = "OPENCLAW_SUPABASE_ANON_KEY"
          value = var.openclaw_supabase_anon_key
        },
        {
          name  = "OPENCLAW_CREDENTIALS_TABLE"
          value = var.openclaw_credentials_table
        },
        {
          name  = "MODE"
          value = var.broker_mode
        },
        {
          name  = "QUEUE_URL"
          value = aws_sqs_queue.default.id
        },
        {
          name  = "ARTIFACTS_BUCKET"
          value = aws_s3_bucket.artifacts.bucket
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
        var.openclaw_supabase_service_role_secret_arn != null ? [
          {
            name      = "SUPABASE_SERVICE_ROLE_KEY"
            valueFrom = var.openclaw_supabase_service_role_secret_arn
          }
        ] : [],
      )
    },
    length(var.broker_command) > 0 ? { command = var.broker_command } : {}
  )

  gateway_secret_arn_parts       = split(":", var.openclaw_gateway_password_secret_arn)
  gateway_secret_base_arn        = length(local.gateway_secret_arn_parts) > 7 ? join(":", slice(local.gateway_secret_arn_parts, 0, 7)) : var.openclaw_gateway_password_secret_arn
  supabase_secret_arn_parts      = var.openclaw_supabase_service_role_secret_arn != null ? split(":", var.openclaw_supabase_service_role_secret_arn) : []
  supabase_secret_base_arn       = var.openclaw_supabase_service_role_secret_arn != null ? (length(local.supabase_secret_arn_parts) > 7 ? join(":", slice(local.supabase_secret_arn_parts, 0, 7)) : var.openclaw_supabase_service_role_secret_arn) : null
  anthropic_secret_arn_parts     = var.anthropic_api_key_secret_arn != null ? split(":", var.anthropic_api_key_secret_arn) : []
  anthropic_secret_base_arn      = var.anthropic_api_key_secret_arn != null ? (length(local.anthropic_secret_arn_parts) > 7 ? join(":", slice(local.anthropic_secret_arn_parts, 0, 7)) : var.anthropic_api_key_secret_arn) : null
  openai_secret_arn_parts        = var.openai_api_key_secret_arn != null ? split(":", var.openai_api_key_secret_arn) : []
  openai_secret_base_arn         = var.openai_api_key_secret_arn != null ? (length(local.openai_secret_arn_parts) > 7 ? join(":", slice(local.openai_secret_arn_parts, 0, 7)) : var.openai_api_key_secret_arn) : null
  broker_bearer_secret_arn_parts = var.openclaw_broker_bearer_secret_arn != null ? split(":", var.openclaw_broker_bearer_secret_arn) : []
  broker_bearer_secret_base_arn  = var.openclaw_broker_bearer_secret_arn != null ? (length(local.broker_bearer_secret_arn_parts) > 7 ? join(":", slice(local.broker_bearer_secret_arn_parts, 0, 7)) : var.openclaw_broker_bearer_secret_arn) : null
  provider_secret_base_arns      = compact([local.anthropic_secret_base_arn, local.openai_secret_base_arn])
  provider_secret_arns_with_wild = [for arn in local.provider_secret_base_arns : "${arn}*"]
  ecs_execution_secret_allow_arns = concat(
    [local.gateway_secret_base_arn, "${local.gateway_secret_base_arn}*"],
    local.supabase_secret_base_arn != null ? [local.supabase_secret_base_arn, "${local.supabase_secret_base_arn}*"] : [],
    local.broker_bearer_secret_base_arn != null ? [local.broker_bearer_secret_base_arn, "${local.broker_bearer_secret_base_arn}*"] : [],
    local.provider_secret_base_arns,
    local.provider_secret_arns_with_wild,
  )
  # Supabase-first runtime config: do not inject provider API keys via ECS env.
  # Gateway should surface config_missing/config_unavailable and drive UI setup flow.
  gateway_provider_secret_bindings = []
}

resource "aws_cloudwatch_log_group" "broker" {
  name              = var.broker_log_group_name
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "gateway" {
  name              = var.gateway_log_group_name
  retention_in_days = 14
}

resource "aws_security_group" "broker_service" {
  name        = var.broker_security_group_name
  description = "Broker ECS service security group"
  vpc_id      = local.platform_vpc_id

  lifecycle {
    precondition {
      condition     = local.platform_alb_security_group_id != null && local.platform_alb_security_group_id != ""
      error_message = "ALB security group ID is missing. Set var.alb_security_group_id in deploy config or expose alb_security_group_id/alb_sg_id in shared platform state."
    }
  }

  ingress {
    description     = "Allow ALB to reach broker"
    from_port       = var.broker_target_group_port
    to_port         = var.broker_target_group_port
    protocol        = "tcp"
    security_groups = compact([local.platform_alb_security_group_id])
  }

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name = var.broker_task_execution_role_name

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

resource "aws_iam_role_policy_attachment" "ecs_task_execution_base" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    sid = "ReadGatewaySecret"
    actions = [
      "secretsmanager:GetSecretValue"
    ]
    resources = local.ecs_execution_secret_allow_arns
  }
}

resource "aws_iam_policy" "ecs_task_execution_secrets" {
  name   = var.broker_task_execution_secrets_policy_name
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_secrets" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = aws_iam_policy.ecs_task_execution_secrets.arn
}

resource "aws_iam_role" "ecs_task" {
  name = var.broker_task_role_name

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

data "aws_iam_policy_document" "ecs_task_broker_queue_mode" {
  statement {
    sid = "SqsSendDefaultQueue"
    actions = [
      "sqs:SendMessage",
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

  statement {
    sid = "CredentialSecretsRW"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret"
    ]
    resources = [
      "arn:aws:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:openclaw/credentials/*"
    ]
  }
}

resource "aws_iam_policy" "ecs_task_broker_queue_mode" {
  name   = var.broker_task_queue_policy_name
  policy = data.aws_iam_policy_document.ecs_task_broker_queue_mode.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_broker_queue_mode" {
  role       = aws_iam_role.ecs_task.name
  policy_arn = aws_iam_policy.ecs_task_broker_queue_mode.arn
}

resource "aws_ecs_task_definition" "openclaw_broker" {
  family                   = var.broker_task_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    local.broker_container
  ])
}

resource "aws_ecs_service" "openclaw_broker" {
  name            = var.broker_service_name
  cluster         = local.platform_ecs_cluster
  task_definition = aws_ecs_task_definition.openclaw_broker.arn
  desired_count   = var.broker_service_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = local.platform_private_subnet_ids
    security_groups  = [aws_security_group.broker_service.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.broker_api.arn
    container_name   = "broker"
    container_port   = var.broker_target_group_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [
    aws_lb_listener_rule.broker_api,
    aws_ecs_service.openclaw_gateway
  ]
}

output "ecs_service_name" {
  value = aws_ecs_service.openclaw_broker.name
}

output "broker_ecs_service_name" {
  value = aws_ecs_service.openclaw_broker.name
}
