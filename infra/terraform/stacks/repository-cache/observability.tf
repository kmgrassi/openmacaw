locals {
  observability_metric_namespace = "${var.project_name}/${var.environment}/repository-cache"

  cleanup_failure_log_metric_filters = {
    repository_cache_cleanup_failed = {
      pattern     = "{ $.event = \"repository_cache_cleanup_failed\" }"
      metric_name = "RepositoryCacheCleanupFailures"
    }
    repository_cache_lease_delete_failed = {
      pattern     = "{ $.event = \"repository_cache_lease_delete_failed\" }"
      metric_name = "RepositoryCacheLeaseDeleteFailures"
    }
    repository_cache_prune_failed = {
      pattern     = "{ $.event = \"repository_cache_prune_failed\" }"
      metric_name = "RepositoryCachePruneFailures"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "cleanup_failure_events" {
  for_each = local.create_cleanup_resources ? local.cleanup_failure_log_metric_filters : {}

  name           = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  log_group_name = aws_cloudwatch_log_group.cleanup[0].name
  pattern        = each.value.pattern

  metric_transformation {
    name      = each.value.metric_name
    namespace = local.observability_metric_namespace
    value     = "1"
    unit      = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "cleanup_failure_events" {
  for_each = local.create_cleanup_resources ? local.cleanup_failure_log_metric_filters : {}

  alarm_name                = "${local.name_prefix}-${replace(each.key, "_", "-")}"
  alarm_description         = "Repository cache cleanup observed ${replace(each.key, "_", " ")} events in CloudWatch logs."
  namespace                 = local.observability_metric_namespace
  metric_name               = each.value.metric_name
  statistic                 = "Sum"
  period                    = 300
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = lookup(var.cleanup_failure_alarm_thresholds, each.key, 1)
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  treat_missing_data        = "notBreaching"
  alarm_actions             = var.alarm_actions
  ok_actions                = var.ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  depends_on = [aws_cloudwatch_log_metric_filter.cleanup_failure_events]
}

resource "aws_cloudwatch_metric_alarm" "cleanup_schedule_failed_invocations" {
  count = local.create_cleanup_resources ? 1 : 0

  alarm_name                = "${local.name_prefix}-repository-cache-cleanup-schedule-failed-invocations"
  alarm_description         = "EventBridge failed to invoke the scheduled repository cache cleanup ECS task."
  namespace                 = "AWS/Events"
  metric_name               = "FailedInvocations"
  statistic                 = "Sum"
  period                    = 300
  evaluation_periods        = 1
  datapoints_to_alarm       = 1
  threshold                 = 1
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  treat_missing_data        = "notBreaching"
  alarm_actions             = var.alarm_actions
  ok_actions                = var.ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  dimensions = {
    RuleName = aws_cloudwatch_event_rule.cleanup[0].name
  }
}

resource "aws_cloudwatch_metric_alarm" "efs_low_burst_credits" {
  alarm_name                = "${local.name_prefix}-repository-cache-efs-low-burst-credits"
  alarm_description         = "Repository cache EFS burst credits are low; clone/fetch cache performance may degrade."
  namespace                 = "AWS/EFS"
  metric_name               = "BurstCreditBalance"
  statistic                 = "Minimum"
  period                    = 300
  evaluation_periods        = 3
  datapoints_to_alarm       = 2
  threshold                 = var.efs_burst_credit_balance_threshold
  comparison_operator       = "LessThanThreshold"
  treat_missing_data        = "notBreaching"
  alarm_actions             = var.alarm_actions
  ok_actions                = var.ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  dimensions = {
    FileSystemId = aws_efs_file_system.repository_cache.id
  }
}

resource "aws_cloudwatch_metric_alarm" "efs_high_io_limit" {
  alarm_name                = "${local.name_prefix}-repository-cache-efs-high-io-limit"
  alarm_description         = "Repository cache EFS is approaching its IO limit."
  namespace                 = "AWS/EFS"
  metric_name               = "PercentIOLimit"
  statistic                 = "Maximum"
  period                    = 300
  evaluation_periods        = 3
  datapoints_to_alarm       = 2
  threshold                 = var.efs_percent_io_limit_threshold
  comparison_operator       = "GreaterThanOrEqualToThreshold"
  treat_missing_data        = "notBreaching"
  alarm_actions             = var.alarm_actions
  ok_actions                = var.ok_actions
  insufficient_data_actions = var.insufficient_data_actions

  dimensions = {
    FileSystemId = aws_efs_file_system.repository_cache.id
  }
}
