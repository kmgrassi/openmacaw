data "terraform_remote_state" "shared_platform" {
  count   = var.shared_platform_state_enabled ? 1 : 0
  backend = "s3"

  config = {
    bucket = var.shared_platform_state_bucket
    key    = var.shared_platform_state_key
    region = var.shared_platform_state_region
  }
}

locals {
  shared_platform_outputs = try(data.terraform_remote_state.shared_platform[0].outputs, {})

  resolved_vpc_id          = trimspace(var.vpc_id) != "" ? trimspace(var.vpc_id) : try(trimspace(local.shared_platform_outputs.vpc_id), "")
  resolved_public_subnets  = length(var.public_subnets) > 0 ? var.public_subnets : try(local.shared_platform_outputs.public_subnet_ids, try(local.shared_platform_outputs.public_subnets, []))
  resolved_private_subnets = length(var.private_subnets) > 0 ? var.private_subnets : try(local.shared_platform_outputs.private_subnet_ids, try(local.shared_platform_outputs.private_subnets, []))

  task_subnets = length(local.resolved_private_subnets) > 0 ? local.resolved_private_subnets : local.resolved_public_subnets

  resolved_ecs_cluster_reference = trimspace(var.existing_ecs_cluster_name) != "" ? trimspace(var.existing_ecs_cluster_name) : (
    trimspace(var.ecs_cluster_name) != "" ? trimspace(var.ecs_cluster_name) : try(trimspace(local.shared_platform_outputs.ecs_cluster_name), "")
  )
  ecs_cluster_reference = var.create_ecs_cluster ? aws_ecs_cluster.symphony[0].id : local.resolved_ecs_cluster_reference
  ecs_cluster_name = var.create_ecs_cluster ? aws_ecs_cluster.symphony[0].name : (
    startswith(local.resolved_ecs_cluster_reference, "arn:") ? element(split("/", local.resolved_ecs_cluster_reference), 1) : local.resolved_ecs_cluster_reference
  )

  # ALB is NOT managed by this stack. The launcher is intentionally
  # reachable only from inside the VPC (ECS service discovery via
  # openmacaw-launcher-dev.internal:4100 by default). Public routing
  # for any hostname should be owned by one separate edge stack.
  #
  # Do not add ALB / target-group / listener-rule resources back here.
  #
  # State migration for the removal is in migrations.tf (`removed` blocks
  # with `destroy = false`) so the deploy-main workflow can auto-apply
  # without tearing down still-shared AWS objects.

  base_container_environment = {
    PHOENIX_HOST                = "127.0.0.1"
    WORKFLOW_PATH               = "/app/elixir/WORKFLOW.md"
    TRACKER_KIND                = "linear"
    LOG_LEVEL                   = "info"
    CONFIG_RELOAD_ENABLED       = "true"
    SYMPHONY_TERMINAL_DASHBOARD = "false"
    AWS_REGION                  = var.aws_region
    AWS_DEFAULT_REGION          = var.aws_region
    LAUNCHER_PORT               = tostring(var.container_port)
    LAUNCHER_BIND_HOST          = "0.0.0.0"
    LAUNCHER_STATE_DIR          = "/tmp/openmacaw/launcher"
    # Setting this makes the launcher serve the local-relay WebSocket on this
    # port (LocalRelay.Supervisor). Empty string is filtered out below, leaving
    # the relay socket off. Orchestrator port allocation skips it (Gate 1).
    RELAY_SOCKET_PORT   = var.relay_socket_port > 0 ? tostring(var.relay_socket_port) : ""
    SUPABASE_URL        = var.supabase_url
    SUPABASE_ANON_KEY   = var.supabase_anon_key
    SUPABASE_JWT_SECRET = var.supabase_jwt_secret
  }

  openclaw_environment = var.openclaw_enabled ? {
    OPENCLAW_ENABLED            = "true"
    OPENCLAW_BASE_URL           = var.openclaw_base_url
    OPENCLAW_API_VERSION        = var.openclaw_api_version
    OPENCLAW_REQUEST_TIMEOUT_MS = tostring(var.openclaw_request_timeout_ms)
    OPENCLAW_MAX_CONCURRENT     = tostring(var.openclaw_max_concurrent_runs)
  } : {}

  container_environment_map = merge(
    local.base_container_environment,
    local.openclaw_environment,
    var.container_environment
  )

  container_environment = [
    for k, v in local.container_environment_map : {
      name  = k
      value = v
    }
    if v != ""
  ]

  container_secret_map = merge(
    var.container_secrets,
    var.supabase_service_role_key_ssm_arn != "" ? { SUPABASE_SERVICE_ROLE_KEY = var.supabase_service_role_key_ssm_arn } : {}
  )

  container_secrets = [
    for k, v in local.container_secret_map : {
      name      = k
      valueFrom = v
    }
    if v != ""
  ]

  task_exec_role_arn   = var.task_execution_role_arn != "" ? var.task_execution_role_arn : aws_iam_role.task_execution[0].arn
  task_role_arn        = var.task_role_arn != "" ? var.task_role_arn : aws_iam_role.task_role[0].arn
  container_entrypoint = var.container_command
}

data "aws_vpc" "main" {
  id = local.resolved_vpc_id
}

data "aws_partition" "current" {}

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "task_execution" {
  count = var.task_execution_role_arn == "" ? 1 : 0

  name = "${var.project_name}-${var.environment_name}-ecs-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  count      = var.task_execution_role_arn == "" ? 1 : 0
  role       = aws_iam_role.task_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  count = var.task_execution_role_arn == "" ? 1 : 0

  name = "${var.project_name}-${var.environment_name}-ecs-exec-secrets"
  role = aws_iam_role.task_execution[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_role" "task_role" {
  count = var.task_role_arn == "" ? 1 : 0

  name = "${var.project_name}-${var.environment_name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_role_ssm" {
  count      = var.task_role_arn == "" ? 1 : 0
  role       = aws_iam_role.task_role[0].name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess"
}

resource "aws_iam_role_policy" "task_role_secretsmanager" {
  count = var.task_role_arn == "" && length(var.secretsmanager_secret_arns) > 0 ? 1 : 0

  name = "${var.project_name}-${var.environment_name}-secretsmanager-read"
  role = aws_iam_role.task_role[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat(
      [{
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.secretsmanager_secret_arns
      }],
      length(var.secretsmanager_kms_key_arns) > 0 ? [{
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = var.secretsmanager_kms_key_arns
      }] : []
    )
  })
}

resource "aws_security_group" "ecs_service" {
  name = "${var.project_name}-${var.environment_name}-service"
  # description is a ForceNew attribute — changing it makes Terraform
  # destroy + recreate the SG, which fails with DependencyViolation while
  # ECS tasks still reference it via their ENIs. Keep this string stable;
  # the "VPC-internal only" semantics are documented in the locals-block
  # comment above, not in the resource description.
  description = "Service security group for the OpenMacaw runtime ECS task."
  vpc_id      = local.resolved_vpc_id

  ingress {
    description = "Allow other VPC services (e.g. the platform API via ECS service discovery) to reach the launcher."
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.main.cidr_block]
  }

  # The ALB (same VPC) reaches the local-relay WebSocket on the relay port.
  # Scoped to the VPC CIDR, matching the launcher rule above.
  dynamic "ingress" {
    for_each = var.relay_socket_port > 0 ? [1] : []
    content {
      description = "Allow the ALB (same VPC) to reach the local-relay WebSocket socket."
      from_port   = var.relay_socket_port
      to_port     = var.relay_socket_port
      protocol    = "tcp"
      cidr_blocks = [data.aws_vpc.main.cidr_block]
    }
  }

  egress {
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }
}

resource "aws_cloudwatch_log_group" "symphony" {
  name              = "/aws/ecs/${var.project_name}/${var.environment_name}/${var.service_name}"
  retention_in_days = 14
}

resource "aws_ecs_cluster" "symphony" {
  count = var.create_ecs_cluster ? 1 : 0
  name  = local.resolved_ecs_cluster_reference

  lifecycle {
    precondition {
      condition     = trimspace(local.resolved_ecs_cluster_reference) != ""
      error_message = "ecs_cluster_name must be set when create_ecs_cluster is true."
    }
  }
}

resource "aws_ecs_task_definition" "symphony" {
  family                   = "${var.project_name}-${var.environment_name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = local.task_exec_role_arn
  task_role_arn            = local.task_role_arn

  dynamic "volume" {
    for_each = var.enable_efs ? [1] : []
    content {
      name = var.workspace_volume_name

      efs_volume_configuration {
        file_system_id     = var.efs_file_system_id
        root_directory     = "/"
        transit_encryption = "ENABLED"

        authorization_config {
          access_point_id = var.efs_access_point_id
          iam             = "ENABLED"
        }
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = var.service_name
      image     = "${var.ecr_repository_uri}:${var.image_tag}"
      essential = true
      command   = local.container_entrypoint

      portMappings = concat(
        [{
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }],
        var.relay_socket_port > 0 ? [{
          containerPort = var.relay_socket_port
          hostPort      = var.relay_socket_port
          protocol      = "tcp"
        }] : []
      )

      environment = local.container_environment
      secrets     = local.container_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.symphony.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = var.service_name
        }
      }

      mountPoints = var.enable_efs ? [{
        sourceVolume  = var.workspace_volume_name
        containerPath = var.workspace_mount_path
        readOnly      = false
      }] : []
    }
  ])
}

# Relay target groups are created and owned by the separate edge stack.
# Looked up by name so there is no cross-repo ARN plumbing — apply that repo
# first. Empty name disables the relay attachment entirely (dev/other envs).
data "aws_lb_target_group" "relay" {
  count = var.relay_target_group_name != "" ? 1 : 0
  name  = var.relay_target_group_name
}

resource "aws_ecs_service" "symphony" {
  name             = var.service_name
  cluster          = local.ecs_cluster_reference
  task_definition  = aws_ecs_task_definition.symphony.arn
  desired_count    = var.desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  network_configuration {
    subnets          = local.task_subnets
    security_groups  = [aws_security_group.ecs_service.id]
    assign_public_ip = false
  }

  # Register with Cloud Map when a namespace is configured so the platform
  # API can reach the launcher via private DNS (see service_discovery.tf).
  dynamic "service_registries" {
    for_each = var.service_discovery_namespace != "" ? [1] : []
    content {
      registry_arn = aws_service_discovery_service.launcher[0].arn
    }
  }

  # Wider grace when attached to the relay target group so the task's relay
  # endpoint has time to bind and pass the target group health check before
  # ECS counts it unhealthy (avoids cycling the orchestrator service on roll).
  health_check_grace_period_seconds  = var.relay_target_group_name != "" ? 120 : 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # The launcher control API (4100) stays VPC-internal (service discovery).
  # When a relay target group is configured, the task ALSO registers its relay
  # socket port into that ALB target group so the public /local-relay/* ingress
  # (owned by the edge stack) reaches it. This is an attachment to an
  # externally-owned target group — this module still creates no ALB /
  # target-group / listener-rule resources.
  dynamic "load_balancer" {
    for_each = var.relay_target_group_name != "" ? [1] : []
    content {
      target_group_arn = data.aws_lb_target_group.relay[0].arn
      container_name   = var.service_name
      container_port   = var.relay_socket_port
    }
  }

  lifecycle {
    precondition {
      condition     = trimspace(local.ecs_cluster_name) != ""
      error_message = "No ECS cluster was resolved. Set ecs_cluster_name, existing_ecs_cluster_name, or enable shared platform state with ecs_cluster_name output."
    }
  }
}

resource "aws_appautoscaling_target" "ecs" {
  count              = var.autoscaling_enabled ? 1 : 0
  max_capacity       = var.autoscaling_max
  min_capacity       = var.autoscaling_min
  resource_id        = "service/${local.ecs_cluster_name}/${aws_ecs_service.symphony.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "ecs_cpu" {
  count              = var.autoscaling_enabled ? 1 : 0
  name               = "${var.project_name}-${var.environment_name}-cpu-target"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs[0].resource_id
  scalable_dimension = aws_appautoscaling_target.ecs[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs[0].service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }

    target_value       = var.autoscaling_target_cpu
    scale_in_cooldown  = var.autoscaling_scale_in_cooldown
    scale_out_cooldown = var.autoscaling_scale_out_cooldown
    disable_scale_in   = false
  }
}
