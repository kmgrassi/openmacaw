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

# S3 is reached via the gateway endpoint (a managed prefix list, not a CIDR),
# and is required for ECR image-layer pulls and artifact writes. Without this
# rule the executor SG blocks S3, so image pulls fail even with the interface
# endpoints reachable.
data "aws_ec2_managed_prefix_list" "s3" {
  name = "com.amazonaws.${var.aws_region}.s3"
}

resource "aws_vpc_security_group_egress_rule" "executor_s3" {
  security_group_id = aws_security_group.executor_tasks.id
  description       = "HTTPS egress to S3 (ECR layers + artifacts) via the gateway endpoint"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  prefix_list_id    = data.aws_ec2_managed_prefix_list.s3.id
}
