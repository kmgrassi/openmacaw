locals {
  interface_endpoint_services = {
    ecr_api        = "com.amazonaws.${var.aws_region}.ecr.api"
    ecr_dkr        = "com.amazonaws.${var.aws_region}.ecr.dkr"
    secretsmanager = "com.amazonaws.${var.aws_region}.secretsmanager"
    logs           = "com.amazonaws.${var.aws_region}.logs"
  }

  # Use the caller-provided endpoint SG if given; otherwise create one below.
  manage_endpoint_sg         = var.create_vpc_endpoints && var.endpoint_security_group_id == ""
  endpoint_security_group_id = var.endpoint_security_group_id != "" ? var.endpoint_security_group_id : (local.manage_endpoint_sg ? aws_security_group.endpoints[0].id : "")
}

data "aws_vpc" "this" {
  id = var.vpc_id
}

# Endpoint security group: allows HTTPS from inside the VPC to the interface
# endpoints, so executor tasks can reach ECR/Secrets/Logs privately. Created
# only when endpoints are enabled and no SG was supplied.
resource "aws_security_group" "endpoints" {
  count = local.manage_endpoint_sg ? 1 : 0

  name        = "${local.name_prefix}-vpc-endpoints"
  description = "HTTPS from the VPC to container-execution interface endpoints"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${local.name_prefix}-vpc-endpoints"
  }
}

resource "aws_vpc_security_group_ingress_rule" "endpoints_https" {
  count = local.manage_endpoint_sg ? 1 : 0

  security_group_id = aws_security_group.endpoints[0].id
  description       = "HTTPS from the VPC"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = data.aws_vpc.this.cidr_block
}

data "aws_route_tables" "private_by_subnet" {
  for_each = toset(var.private_subnet_ids)

  vpc_id = var.vpc_id

  filter {
    name   = "association.subnet-id"
    values = [each.value]
  }
}

locals {
  private_route_table_ids = toset([
    for route_tables in values(data.aws_route_tables.private_by_subnet) : route_tables.ids[0]
  ])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = var.create_vpc_endpoints ? local.interface_endpoint_services : {}

  vpc_id              = var.vpc_id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  private_dns_enabled = true

  security_group_ids = [
    local.endpoint_security_group_id
  ]

  tags = {
    Name = "${local.name_prefix}-${each.key}-endpoint"
  }
}

resource "aws_vpc_endpoint" "s3_gateway" {
  count = var.create_vpc_endpoints ? 1 : 0

  vpc_id            = var.vpc_id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = local.private_route_table_ids

  tags = {
    Name = "${local.name_prefix}-s3-gateway-endpoint"
  }
}
