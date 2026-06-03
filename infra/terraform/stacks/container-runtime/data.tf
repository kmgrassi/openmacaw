data "terraform_remote_state" "foundation" {
  backend = "s3"

  config = {
    bucket = var.foundation_state_bucket
    key    = var.foundation_state_key
    region = var.foundation_state_region
  }
}

locals {
  name_prefix = "${var.project_name}-${var.environment}"

  executor_image = "${data.terraform_remote_state.foundation.outputs.container_executor_ecr_repository_url}:${var.executor_image_tag}"

  artifact_bucket_name = data.terraform_remote_state.foundation.outputs.container_artifact_bucket_name
  artifact_bucket_arn  = "arn:aws:s3:::${local.artifact_bucket_name}"
  artifact_kms_key_arn = data.terraform_remote_state.foundation.outputs.container_artifact_kms_key_arn
  artifact_prefix_root = trim(var.artifact_prefix_root, "/")
  artifact_write_prefix = join("/", [
    local.artifact_prefix_root,
    trim(var.artifact_workspace_id, "/"),
    trim(var.artifact_run_id, "/"),
  ])
}
