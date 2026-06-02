resource "aws_kms_key" "artifacts" {
  description             = "KMS key for ${local.name_prefix} container execution artifacts"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "artifacts" {
  name          = "alias/${local.name_prefix}-container-artifacts"
  target_key_id = aws_kms_key.artifacts.key_id
}

resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifact_bucket_name
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.artifacts.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-executor-artifacts"
    status = "Enabled"

    filter {
      prefix = "${local.artifact_prefix_root}/"
    }

    expiration {
      days = var.artifact_retention_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.artifact_retention_days
    }
  }
}
