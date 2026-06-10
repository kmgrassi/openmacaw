locals {
  network_firewall_subnet_ids = length(var.network_firewall_subnet_ids) > 0 ? var.network_firewall_subnet_ids : var.private_subnet_ids
  network_firewall_endpoint_ids_by_subnet_id = {
    for sync_state in aws_networkfirewall_firewall.executor_egress.firewall_status[0].sync_states :
    sync_state.attachment[0].subnet_id => sync_state.attachment[0].endpoint_id
  }
}

resource "aws_networkfirewall_rule_group" "egress_allowlist" {
  name     = "${local.name_prefix}-executor-egress-allow"
  capacity = var.network_firewall_rule_group_capacity
  type     = "STATEFUL"

  rule_group {
    rules_source {
      rules_source_list {
        generated_rules_type = "ALLOWLIST"
        target_types         = ["HTTP_HOST", "TLS_SNI"]
        targets              = var.network_firewall_allowed_domains
      }
    }

    stateful_rule_options {
      rule_order = "STRICT_ORDER"
    }
  }

  tags = {
    Name = "${local.name_prefix}-executor-egress-allow"
  }
}

resource "aws_networkfirewall_firewall_policy" "executor_egress" {
  name = "${local.name_prefix}-executor-egress"

  firewall_policy {
    stateless_default_actions          = ["aws:forward_to_sfe"]
    stateless_fragment_default_actions = ["aws:forward_to_sfe"]
    stateful_default_actions           = ["aws:drop_established", "aws:alert_established"]

    stateful_engine_options {
      rule_order = "STRICT_ORDER"
    }

    stateful_rule_group_reference {
      priority     = 100
      resource_arn = aws_networkfirewall_rule_group.egress_allowlist.arn
    }
  }

  tags = {
    Name = "${local.name_prefix}-executor-egress"
  }
}

resource "aws_networkfirewall_firewall" "executor_egress" {
  name                = "${local.name_prefix}-executor-egress"
  firewall_policy_arn = aws_networkfirewall_firewall_policy.executor_egress.arn
  vpc_id              = var.vpc_id

  delete_protection                 = var.network_firewall_delete_protection
  subnet_change_protection          = var.network_firewall_subnet_change_protection
  firewall_policy_change_protection = var.network_firewall_policy_change_protection

  dynamic "subnet_mapping" {
    for_each = toset(local.network_firewall_subnet_ids)

    content {
      subnet_id = subnet_mapping.value
    }
  }

  tags = {
    Name = "${local.name_prefix}-executor-egress"
  }

  lifecycle {
    precondition {
      condition     = length(local.network_firewall_subnet_ids) > 0
      error_message = "At least one network firewall subnet is required."
    }
  }
}

resource "aws_route" "executor_egress_to_firewall" {
  for_each = var.network_firewall_protected_route_table_map

  route_table_id         = each.key
  destination_cidr_block = var.network_firewall_route_destination_cidr_block
  vpc_endpoint_id        = local.network_firewall_endpoint_ids_by_subnet_id[each.value]

  depends_on = [aws_networkfirewall_firewall.executor_egress]
}

# Symmetric return path. AWS Network Firewall is stateful and requires response
# traffic to re-enter the same endpoint. Each entry adds a route in the
# NAT/edge route table for an executor CIDR back through the same-AZ firewall
# endpoint, so return traffic doesn't bypass inspection via the local VPC route.
resource "aws_route" "executor_return_to_firewall" {
  for_each = {
    for r in var.network_firewall_return_routes :
    "${r.route_table_id}-${r.destination_cidr_block}" => r
  }

  route_table_id         = each.value.route_table_id
  destination_cidr_block = each.value.destination_cidr_block
  vpc_endpoint_id        = local.network_firewall_endpoint_ids_by_subnet_id[each.value.firewall_subnet_id]

  depends_on = [aws_networkfirewall_firewall.executor_egress]
}

check "network_firewall_routes_configured" {
  assert {
    condition     = !contains(var.egress_cidr_blocks, "0.0.0.0/0") || length(var.network_firewall_protected_route_table_map) > 0
    error_message = "Broad executor HTTPS egress requires network_firewall_protected_route_table_map so traffic is routed through Network Firewall."
  }

  assert {
    condition = alltrue([
      for subnet_id in values(var.network_firewall_protected_route_table_map) :
      contains(local.network_firewall_subnet_ids, subnet_id)
    ])
    error_message = "Every network_firewall_protected_route_table_map value must be one of the configured Network Firewall subnet IDs."
  }

  assert {
    condition = alltrue([
      for r in var.network_firewall_return_routes :
      contains(local.network_firewall_subnet_ids, r.firewall_subnet_id)
    ])
    error_message = "Every network_firewall_return_routes firewall_subnet_id must be one of the configured Network Firewall subnet IDs."
  }
}
