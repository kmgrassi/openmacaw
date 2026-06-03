data "aws_caller_identity" "backbone" {}

locals {
  artifacts_bucket_name_effective = var.artifacts_bucket_name != null && var.artifacts_bucket_name != "" ? var.artifacts_bucket_name : "openclaw-artifacts-dev-${data.aws_caller_identity.backbone.account_id}-${var.aws_region}"
}

resource "aws_s3_bucket" "artifacts" {
  bucket = local.artifacts_bucket_name_effective
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
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = var.artifacts_lifecycle_rule_id
    status = "Enabled"

    filter {
      prefix = ""
    }

    expiration {
      days = var.artifacts_expiration_days
    }
  }
}

resource "aws_sqs_queue" "default_dlq" {
  name = "${var.queue_default_name}-dlq"
}

resource "aws_sqs_queue" "browser_dlq" {
  name = "${var.queue_browser_name}-dlq"
}

resource "aws_sqs_queue" "local_dlq" {
  name = "${var.queue_local_name}-dlq"
}

resource "aws_sqs_queue" "default" {
  name                       = var.queue_default_name
  visibility_timeout_seconds = var.queue_visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.default_dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })
}

resource "aws_sqs_queue" "browser" {
  name                       = var.queue_browser_name
  visibility_timeout_seconds = var.queue_visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.browser_dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })
}

resource "aws_sqs_queue" "local" {
  name                       = var.queue_local_name
  visibility_timeout_seconds = var.queue_visibility_timeout_seconds
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.local_dlq.arn
    maxReceiveCount     = var.queue_max_receive_count
  })
}

output "artifacts_bucket_name" {
  value = aws_s3_bucket.artifacts.bucket
}

output "terraform_lock_table_name" {
  value = var.terraform_lock_table_name
}

output "queue_default_url" {
  value = aws_sqs_queue.default.url
}

output "queue_browser_url" {
  value = aws_sqs_queue.browser.url
}

output "queue_local_url" {
  value = aws_sqs_queue.local.url
}
