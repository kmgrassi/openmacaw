resource "aws_kms_key" "container_artifacts" {
  description             = "KMS key for ${local.name_prefix} container execution artifacts"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "container_artifacts" {
  name          = "alias/${local.name_prefix}-container-artifacts"
  target_key_id = aws_kms_key.container_artifacts.key_id
}

resource "aws_s3_bucket" "container_artifacts" {
  bucket = "${local.name_prefix}-container-artifacts-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_public_access_block" "container_artifacts" {
  bucket = aws_s3_bucket.container_artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "container_artifacts" {
  bucket = aws_s3_bucket.container_artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.container_artifacts.arn
      sse_algorithm     = "aws:kms"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "container_artifacts" {
  bucket = aws_s3_bucket.container_artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "container_artifacts" {
  bucket = aws_s3_bucket.container_artifacts.id

  rule {
    id     = "expire-container-execution-artifacts"
    status = "Enabled"

    filter {
      prefix = "workspaces/"
    }

    expiration {
      days = var.artifact_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.artifact_retention_days
    }
  }
}
