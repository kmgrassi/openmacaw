# ── Target Group ──────────────────────────────────────────────

resource "aws_lb_target_group" "app" {
  name        = "${local.name_prefix}-server-tg"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = local.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/livez"
    port                = "traffic-port"
    protocol            = "HTTP"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    timeout             = 5
    interval            = 30
    matcher             = "200"
  }

  deregistration_delay = 30
}

# ── ALB Listener Rule ────────────────────────────────────────
# Conditional: only managed here when this stack owns the public edge
# (standalone mode, no shared platform state). In shared-state mode,
# the shared edge stack should own listener rules and point at the target
# group created here. Keeping one owner per hostname avoids cross-state
# listener-rule collisions.
#
# When `local.manage_public_edge = true`, there is no shared edge to defer
# to, so this module must create its own rule (same as the original
# behavior). Keep `count` gated exclusively on `local.manage_public_edge`;
# do not widen the condition without re-introducing the multi-state
# collision risk.

resource "aws_lb_listener_rule" "app" {
  count        = local.manage_public_edge ? 1 : 0
  listener_arn = local.alb_listener_arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }

  condition {
    host_header {
      values = [var.domain_name]
    }
  }
}

# ── ECS Tasks Security Group ────────────────────────────────

resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name_prefix}-ecs-tasks"
  description = "Allow inbound from ALB to ECS tasks"
  vpc_id      = local.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "alb_to_ecs" {
  security_group_id            = aws_security_group.ecs_tasks.id
  description                  = "ALB to ECS tasks"
  from_port                    = var.app_port
  to_port                      = var.app_port
  ip_protocol                  = "tcp"
  referenced_security_group_id = local.alb_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "ecs_all_outbound" {
  security_group_id = aws_security_group.ecs_tasks.id
  description       = "Allow all outbound"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}
