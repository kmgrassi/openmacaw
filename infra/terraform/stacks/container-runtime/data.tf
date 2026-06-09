data "terraform_remote_state" "foundation" {
  backend = "s3"

  config = {
    bucket = var.foundation_state_bucket
    key    = var.foundation_state_key
    region = var.foundation_state_region
  }
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

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

  secret_path_root = trim(var.secret_path_root, "/")
  allowed_secret_arns = concat(
    var.allowed_secret_arns,
    [
      for workspace_id in var.secret_workspace_ids :
      "arn:${data.aws_partition.current.partition}:secretsmanager:${var.aws_region}:${data.aws_caller_identity.current.account_id}:secret:${local.secret_path_root}/workspaces/${workspace_id}/*"
    ]
  )

  per_run_artifact_session_policy_template = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteOnlyThisRunPrefix"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:PutObject",
          "s3:PutObjectTagging",
        ]
        Resource = "$${artifact_bucket_arn}/$${artifact_prefix}/*"
      },
      {
        Sid    = "ReadOnlyThisRunPrefix"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectTagging",
        ]
        Resource = "$${artifact_bucket_arn}/$${artifact_prefix}/*"
      },
      {
        Sid      = "ListOnlyThisRunPrefix"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = "$${artifact_bucket_arn}"
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "$${artifact_prefix}/*",
            ]
          }
        }
      }
    ]
  })
}
