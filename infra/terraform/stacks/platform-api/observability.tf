# ── Platform API Log Metrics ─────────────────────────────────

locals {
  observability_metric_namespace = "${var.project_name}/${var.environment}/platform-api"

  # Every alarm in this stack also notifies the in-stack ops topic, on top of
  # any externally supplied actions. Previously alarms only used
  # var.alarm_actions, which is empty for prod — so every prod alarm fired into
  # the void (the 2026-06 ES256 login outage went unnoticed for days as a
  # result). Wiring the topic here guarantees a destination without depending
  # on per-environment SSM deploy config being populated.
  effective_alarm_actions = concat(var.alarm_actions, [aws_sns_topic.ops_alerts.arn])
  effective_ok_actions    = concat(var.ok_actions, [aws_sns_topic.ops_alerts.arn])

  # Auth metric filters feed the metric-math "everyone is failing to log in"
  # alarm below. default_value = 0 keeps the series continuous so the math
  # (rejected high AND validated zero) evaluates cleanly in quiet periods.
  auth_log_metric_filters = {
    auth_token_rejected = {
      pattern     = "{ $.event = \"auth_token_rejected\" }"
      metric_name = "AuthTokenRejected"
    }
    auth_token_validated = {
      pattern     = "{ $.event = \"auth_token_validated\" }"
      metric_name = "AuthTokenValidated"
    }
  }

  failure_log_metric_filters = {
    model_call_failed = {
      pattern     = "{ $.event = \"model_call_failed\" }"
      metric_name = "ModelCallFailures"
    }
    tool_call_failed = {
      pattern     = "{ $.event = \"tool_call_failed\" }"
      metric_name = "ToolCallFailures"
    }
    gateway_ws_upstream_failed = {
      pattern     = "{ $.event = \"gateway_ws_upstream_failed\" }"
      metric_name = "GatewayWebSocketUpstreamFailures"
    }
    gateway_ws_abnormal_closed = {
      pattern     = "{ ($.event = \"gateway_ws_closed\") && ($.abnormal = true) }"
      metric_name = "GatewayWebSocketAbnormalCloses"
    }
    launcher_unreachable = {
      pattern     = "{ $.event = \"launcher_call_failed\" }"
      metric_name = "LauncherFailures"
    }
    engine_instance_write_failed = {
      pattern     = "{ ($.event = \"engine_instance_upsert_failed\") || ($.event = \"engine_instance_heartbeat_failed\") }"
      metric_name = "EngineInstanceWriteFailures"
    }
    runtime_failure = {
      pattern     = "{ ($.event = \"run_failed\") || ($.event = \"turn_failed\") }"
      metric_name = "RuntimeFailures"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "failure_events" {
  for_each = local.failure_log_metric_filters

  name           = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.value.metric_name
    namespace = local.observability_metric_namespace
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "failure_events" {
  for_each = local.failure_log_metric_filters

  alarm_name                = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  alarm_description         = "Platform API observed ${replace(each.key, "_", " ")} events in CloudWatch logs."
  namespace                 = local.observability_metric_namespace
  metric_name               = each.value.metric_name
  statistic                 = "Sum"
  period                    = 300
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = lookup(var.failure_alarm_thresholds, each.key, 1)
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.effective_alarm_actions
  ok_actions                = local.effective_ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  depends_on = [aws_cloudwatch_log_metric_filter.failure_events]
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  alarm_name                = "${local.name_prefix}-platform-api-unhealthy-targets"
  alarm_description         = "Platform API target group has unhealthy ECS targets."
  namespace                 = "AWS/ApplicationELB"
  metric_name               = "UnHealthyHostCount"
  statistic                 = "Maximum"
  period                    = 60
  evaluation_periods        = 2
  datapoints_to_alarm       = 2
  threshold                 = 1
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  treat_missing_data        = "notBreaching"
  alarm_actions             = local.effective_alarm_actions
  ok_actions                = local.effective_ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  dimensions = {
    LoadBalancer = local.alb_arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }
}

# ── Ops alert topic + auth-outage detection ──────────────────
# Per-environment SNS topic that every alarm in this stack notifies. Email (or
# other) subscribers are attached out of band — the AWS provider cannot manage
# email subscription confirmation, so subscriptions are intentionally not
# Terraform resources. Subscribe with:
#   aws sns subscribe --topic-arn <arn> --protocol email --notification-endpoint you@example.com
resource "aws_sns_topic" "ops_alerts" {
  name = "${local.name_prefix}-ops-alerts"
}

resource "aws_cloudwatch_log_metric_filter" "auth_events" {
  for_each = local.auth_log_metric_filters

  name           = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  log_group_name = aws_cloudwatch_log_group.app.name
  pattern        = each.value.pattern

  metric_transformation {
    name          = each.value.metric_name
    namespace     = local.observability_metric_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Fires when prod login is broken for everyone: across two consecutive one-hour
# windows the API saw auth_token_rejected >= 2 while auth_token_validated == 0,
# i.e. people are trying to sign in and every attempt fails (e.g. a JWT
# algorithm/issuer mismatch). Hourly windows so sparse login traffic still
# accumulates; the validated == 0 gate keeps a single expired token from
# tripping it, and the OK action clears the alarm as soon as one login succeeds.
resource "aws_cloudwatch_metric_alarm" "auth_all_failing" {
  alarm_name          = "${local.name_prefix}-auth-all-failing"
  alarm_description   = "Platform API auth is failing for everyone: auth_token_rejected >= 2 and zero auth_token_validated across two consecutive 1h windows."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  threshold           = 1
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  treat_missing_data  = "notBreaching"

  alarm_actions             = local.effective_alarm_actions
  ok_actions                = local.effective_ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  metric_query {
    id          = "m_rejected"
    return_data = false
    metric {
      namespace   = local.observability_metric_namespace
      metric_name = "AuthTokenRejected"
      period      = 3600
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "m_validated"
    return_data = false
    metric {
      namespace   = local.observability_metric_namespace
      metric_name = "AuthTokenValidated"
      period      = 3600
      stat        = "Sum"
    }
  }

  metric_query {
    id          = "e_all_failing"
    expression  = "(m_rejected >= 2) * (m_validated < 1)"
    label       = "AuthAllFailing"
    return_data = true
  }

  depends_on = [aws_cloudwatch_log_metric_filter.auth_events]
}
