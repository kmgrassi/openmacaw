resource "aws_security_group" "cleanup_task" {
  count = local.create_cleanup_resources ? 1 : 0

  name        = "${local.name_prefix}-repository-cache-cleanup"
  description = "Network boundary for repository cache cleanup task"
  vpc_id      = var.vpc_id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
    description = "Allow cleanup task to reach EFS and AWS service endpoints"
  }

  tags = {
    Name = "${local.name_prefix}-repository-cache-cleanup"
  }
}

resource "aws_cloudwatch_log_group" "cleanup" {
  count = local.create_cleanup_resources ? 1 : 0

  name              = "/aws/ecs/${local.name_prefix}/repository-cache-cleanup"
  retention_in_days = var.cleanup_log_retention_days
}

resource "aws_iam_role" "cleanup_execution" {
  count = local.create_cleanup_resources ? 1 : 0

  name = "${local.name_prefix}-repo-cache-cleanup-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "cleanup_execution_base" {
  count = local.create_cleanup_resources ? 1 : 0

  role       = aws_iam_role.cleanup_execution[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "cleanup_task" {
  count = local.create_cleanup_resources ? 1 : 0

  name = "${local.name_prefix}-repo-cache-cleanup-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "cleanup_task_metrics" {
  count = local.create_cleanup_resources ? 1 : 0

  name = "${local.name_prefix}-repo-cache-cleanup-metrics"
  role = aws_iam_role.cleanup_task[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "cloudwatch:PutMetricData",
        ]
        Resource = "*"
        Condition = {
          StringEquals = {
            "cloudwatch:namespace" = local.observability_metric_namespace
          }
        }
      }
    ]
  })
}

resource "aws_ecs_task_definition" "cleanup" {
  count = local.create_cleanup_resources ? 1 : 0

  family                   = "${local.name_prefix}-repository-cache-cleanup"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cleanup_task_cpu
  memory                   = var.cleanup_task_memory
  execution_role_arn       = aws_iam_role.cleanup_execution[0].arn
  task_role_arn            = aws_iam_role.cleanup_task[0].arn

  runtime_platform {
    cpu_architecture        = "X86_64"
    operating_system_family = "LINUX"
  }

  volume {
    name = "repository-mirrors"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.repository_cache.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.repository_mirrors.id
        iam             = "DISABLED"
      }
    }
  }

  volume {
    name = "session-workspaces"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.repository_cache.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = aws_efs_access_point.session_workspaces.id
        iam             = "DISABLED"
      }
    }
  }

  container_definitions = jsonencode([
    {
      name      = var.cleanup_container_name
      image     = var.cleanup_image
      essential = true
      command   = var.cleanup_command

      environment = [
        { name = "APP_ENV", value = var.environment },
        { name = "REPOSITORY_CACHE_ROOT", value = "/mnt/repository-cache" },
        { name = "SESSION_WORKSPACE_ROOT", value = "/mnt/session-workspaces" },
        { name = "METRIC_NAMESPACE", value = local.observability_metric_namespace },
      ]

      mountPoints = [
        {
          sourceVolume  = "repository-mirrors"
          containerPath = "/mnt/repository-cache"
          readOnly      = false
        },
        {
          sourceVolume  = "session-workspaces"
          containerPath = "/mnt/session-workspaces"
          readOnly      = false
        },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.cleanup[0].name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "repository-cache-cleanup"
        }
      }
    }
  ])

  depends_on = [aws_efs_mount_target.repository_cache]
}

resource "aws_iam_role" "events_run_cleanup" {
  count = local.create_cleanup_resources ? 1 : 0

  name = "${local.name_prefix}-repo-cache-events-run-cleanup"

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

resource "aws_iam_role_policy" "events_run_cleanup" {
  count = local.create_cleanup_resources ? 1 : 0

  name = "${local.name_prefix}-repo-cache-events-run-cleanup"
  role = aws_iam_role.events_run_cleanup[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
        ]
        Resource = aws_ecs_task_definition.cleanup[0].arn
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.ecs_cluster_arn
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "iam:PassRole",
        ]
        Resource = [
          aws_iam_role.cleanup_execution[0].arn,
          aws_iam_role.cleanup_task[0].arn,
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_event_rule" "cleanup" {
  count = local.create_cleanup_resources ? 1 : 0

  name                = "${local.name_prefix}-repository-cache-cleanup"
  description         = "Runs repository cache cleanup for expired session workspace leases and stale mirrors"
  schedule_expression = var.cleanup_schedule_expression
}

resource "aws_cloudwatch_event_target" "cleanup" {
  count = local.create_cleanup_resources ? 1 : 0

  rule     = aws_cloudwatch_event_rule.cleanup[0].name
  arn      = var.ecs_cluster_arn
  role_arn = aws_iam_role.events_run_cleanup[0].arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.cleanup[0].arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"

    network_configuration {
      subnets          = var.private_subnet_ids
      security_groups  = [aws_security_group.cleanup_task[0].id]
      assign_public_ip = false
    }
  }
}
