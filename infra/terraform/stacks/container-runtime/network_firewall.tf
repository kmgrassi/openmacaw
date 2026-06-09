locals {
  network_firewall_subnet_ids = length(var.network_firewall_subnet_ids) > 0 ? var.network_firewall_subnet_ids : var.private_subnet_ids
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
