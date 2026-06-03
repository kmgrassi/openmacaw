resource "aws_cloudwatch_log_group" "gateway_standalone" {
  name              = var.gateway_standalone_log_group_name
  retention_in_days = 14
}

resource "aws_efs_file_system" "openclaw_state" {
  creation_token   = var.state_efs_creation_token
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"
}

resource "aws_security_group" "openclaw_state_efs" {
  name        = var.state_efs_security_group_name
  description = "Allow ECS services to mount OpenClaw state EFS"
  vpc_id      = local.platform_vpc_id

  ingress {
    description     = "NFS from gateway and worker services"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.gateway_service.id, aws_security_group.worker_default_service.id]
  }

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_efs_mount_target" "openclaw_state" {
  for_each = toset(local.platform_private_subnet_ids)

  file_system_id  = aws_efs_file_system.openclaw_state.id
  subnet_id       = each.value
  security_groups = [aws_security_group.openclaw_state_efs.id]
}

resource "aws_efs_access_point" "openclaw_state" {
  file_system_id = aws_efs_file_system.openclaw_state.id

  root_directory {
    path = "/openclaw"
    creation_info {
      owner_gid   = 1000
      owner_uid   = 1000
      permissions = "0755"
    }
  }
}

resource "aws_security_group" "gateway_service" {
  name        = var.gateway_security_group_name
  description = "Dedicated gateway ECS service security group"
  vpc_id      = local.platform_vpc_id

  ingress {
    description     = "Allow broker service to reach gateway"
    from_port       = 18789
    to_port         = 18789
    protocol        = "tcp"
    security_groups = [aws_security_group.broker_service.id]
  }

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_service_discovery_private_dns_namespace" "openclaw" {
  name        = var.gateway_discovery_namespace_name
  description = var.gateway_discovery_namespace_description
  vpc         = local.platform_vpc_id
}

resource "aws_service_discovery_service" "gateway" {
  name = var.gateway_discovery_service_name

  dns_config {
    namespace_id = aws_service_discovery_private_dns_namespace.openclaw.id

    dns_records {
      ttl  = 10
      type = "A"
    }

    routing_policy = "MULTIVALUE"
  }

  health_check_custom_config {
    failure_threshold = 1
  }
}

resource "aws_ecs_task_definition" "openclaw_gateway" {
  family                   = var.gateway_task_family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "gateway"
      image     = var.gateway_image
      essential = true
      command   = ["sh", "-lc", "node openclaw.mjs models set ${var.openclaw_model} && node openclaw.mjs gateway --allow-unconfigured --bind lan"]
      portMappings = [
        {
          containerPort = 18789
          protocol      = "tcp"
        }
      ]
      environment = [
        {
          name  = "OPENCLAW_STATE_DIR"
          value = "/var/openclaw-state"
        },
        {
          name  = "OPENCLAW_SERVICE_NAME"
          value = "gateway-standalone"
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
          name  = "OPENCLAW_GATEWAY_SERVICE_MODE"
          value = "1"
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
          name  = "OPENCLAW_MODEL"
          value = var.openclaw_model
        },
        {
          name  = "OPENCLAW_BROKER_BASE_URL"
          value = var.openclaw_broker_base_url
        },
        {
          name  = "OPENCLAW_CRON_USER_ID"
          value = "operator"
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
          awslogs-group         = aws_cloudwatch_log_group.gateway_standalone.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
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

resource "aws_ecs_service" "openclaw_gateway" {
  name            = var.gateway_service_name
  cluster         = local.platform_ecs_cluster
  task_definition = aws_ecs_task_definition.openclaw_gateway.arn
  desired_count   = var.gateway_service_desired_count
  launch_type     = "FARGATE"

  depends_on = [aws_efs_mount_target.openclaw_state]

  network_configuration {
    subnets          = local.platform_private_subnet_ids
    security_groups  = [aws_security_group.gateway_service.id]
    assign_public_ip = false
  }

  service_registries {
    registry_arn = aws_service_discovery_service.gateway.arn
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

output "gateway_ecs_service_name" {
  value = aws_ecs_service.openclaw_gateway.name
}

output "gateway_service_discovery_fqdn" {
  value = "${aws_service_discovery_service.gateway.name}.${aws_service_discovery_private_dns_namespace.openclaw.name}"
}
