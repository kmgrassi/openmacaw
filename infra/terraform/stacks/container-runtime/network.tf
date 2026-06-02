resource "aws_security_group" "executor_tasks" {
  name        = "${local.name_prefix}-executor-tasks"
  description = "Security group for one-off container executor tasks"
  vpc_id      = var.vpc_id

  egress = []

  tags = {
    Name = "${local.name_prefix}-executor-tasks"
  }
}

resource "aws_vpc_security_group_egress_rule" "executor_https" {
  for_each = toset(var.egress_cidr_blocks)

  security_group_id = aws_security_group.executor_tasks.id
  description       = "HTTPS egress for configured execution dependencies"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = each.value
}
