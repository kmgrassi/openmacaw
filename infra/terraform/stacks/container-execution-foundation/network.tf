locals {
  interface_endpoint_services = {
    ecr_api        = "com.amazonaws.${var.aws_region}.ecr.api"
    ecr_dkr        = "com.amazonaws.${var.aws_region}.ecr.dkr"
    secretsmanager = "com.amazonaws.${var.aws_region}.secretsmanager"
    logs           = "com.amazonaws.${var.aws_region}.logs"
  }
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
    var.endpoint_security_group_id
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
