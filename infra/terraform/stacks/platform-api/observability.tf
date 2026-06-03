# ── Platform API Log Metrics ─────────────────────────────────

locals {
  observability_metric_namespace = "${var.project_name}/${var.environment}/platform-api"

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
  alarm_actions             = var.alarm_actions
  ok_actions                = var.ok_actions
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
  alarm_actions             = var.alarm_actions
  ok_actions                = var.ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  dimensions = {
    LoadBalancer = local.alb_arn_suffix
    TargetGroup  = aws_lb_target_group.app.arn_suffix
  }
}
