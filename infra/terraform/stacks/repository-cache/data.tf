locals {
  name_prefix              = "${var.project_name}-${var.environment}"
  create_cleanup_resources = var.enable_cleanup_schedule
}

check "cleanup_schedule_inputs" {
  assert {
    condition     = !var.enable_cleanup_schedule || var.cleanup_image != ""
    error_message = "cleanup_image must be set when enable_cleanup_schedule is true."
  }

  assert {
    condition     = !var.enable_cleanup_schedule || var.ecs_cluster_arn != ""
    error_message = "ecs_cluster_arn must be set when enable_cleanup_schedule is true."
  }
}
