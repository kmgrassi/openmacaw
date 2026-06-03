locals {
  container_execution_metric_namespace = "${var.project_name}/${var.environment}/container-execution"
}

resource "aws_cloudwatch_log_group" "container_execution_smoke" {
  name              = "/aws/${local.name_prefix}/container-execution/smoke"
  retention_in_days = 30
}

resource "aws_cloudwatch_metric_alarm" "container_execution_smoke_failures" {
  alarm_name          = "${local.name_prefix}-container-execution-smoke-failures"
  alarm_description   = "Container execution smoke tests reported failures for task launch, secret resolution, clone, egress, artifact write, or cleanup."
  namespace           = local.container_execution_metric_namespace
  metric_name         = "SmokeFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
}

resource "aws_cloudwatch_dashboard" "container_execution" {
  dashboard_name = "${local.name_prefix}-container-execution"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title   = "Container execution smoke failures"
          region  = var.aws_region
          metrics = [[local.container_execution_metric_namespace, "SmokeFailures"]]
          stat    = "Sum"
          period  = 300
        }
      },
      {
        type   = "metric"
        width  = 12
        height = 6
        properties = {
          title  = "Resource access path failures"
          region = var.aws_region
          metrics = [
            [local.container_execution_metric_namespace, "TaskLaunchFailures"],
            [local.container_execution_metric_namespace, "SecretResolutionFailures"],
            [local.container_execution_metric_namespace, "CloneFailures"],
            [local.container_execution_metric_namespace, "EgressDenied"],
            [local.container_execution_metric_namespace, "ArtifactWriteFailures"],
            [local.container_execution_metric_namespace, "CleanupFailures"],
          ]
          stat   = "Sum"
          period = 300
        }
      },
      {
        type   = "log"
        width  = 24
        height = 6
        properties = {
          title  = "Recent smoke failures"
          region = var.aws_region
          query  = "SOURCE '${aws_cloudwatch_log_group.container_execution_smoke.name}' | fields @timestamp, @message | filter status = \"failed\" | sort @timestamp desc | limit 20"
          view   = "table"
        }
      },
    ]
  })
}
