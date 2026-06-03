# ─────────────────────────────────────────────────────────────────────────────
# ECS Service Discovery (Cloud Map)
#
# Registers the launcher ECS service with a private DNS name so the platform
# API can reach it VPC-internally. The launcher is deliberately not on the
# public ALB (see docs/auth-jwt-design.md Option B); this Cloud Map entry is
# the only way another in-VPC service resolves it.
#
# Namespace (e.g. "openmacaw-prod.local") is looked up by name. A shared
# infra stack creates the namespace; this stack only creates the
# per-service entry. Leaving `service_discovery_namespace` empty disables
# registration entirely (useful for local dev and ephemeral environments).
#
# Resulting DNS: `<service_discovery_service_name>.<service_discovery_namespace>`
# e.g. `openmacaw-launcher-prod.openmacaw-prod.local`
# ─────────────────────────────────────────────────────────────────────────────

data "aws_service_discovery_dns_namespace" "internal" {
  count = var.service_discovery_namespace != "" ? 1 : 0
  name  = var.service_discovery_namespace
  type  = "DNS_PRIVATE"
}

resource "aws_service_discovery_service" "launcher" {
  count = var.service_discovery_namespace != "" ? 1 : 0
  name  = var.service_discovery_service_name

  dns_config {
    namespace_id   = data.aws_service_discovery_dns_namespace.internal[0].id
    routing_policy = "MULTIVALUE"

    dns_records {
      type = "A"
      ttl  = 10
    }
  }

  # ECS owns registration/deregistration; a custom health check integrates
  # with the ECS task health state so DNS only resolves to healthy tasks.
  health_check_custom_config {
    failure_threshold = 1
  }
}
