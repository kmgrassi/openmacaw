output "container_executor_ecr_repository_name" {
  description = "Container executor ECR repository name"
  value       = aws_ecr_repository.container_executor.name
}

output "container_executor_ecr_repository_url" {
  description = "Container executor ECR repository URL"
  value       = aws_ecr_repository.container_executor.repository_url
}

output "vpc_endpoint_ids" {
  description = "Interface endpoint IDs keyed by service logical name"
  value       = { for key, endpoint in aws_vpc_endpoint.interface : key => endpoint.id }
}

output "container_artifact_bucket_name" {
  description = "S3 bucket for container execution run summaries, logs, patches, and diagnostics"
  value       = aws_s3_bucket.container_artifacts.bucket
}

output "container_artifact_kms_key_arn" {
  description = "KMS key ARN used to encrypt container execution artifacts"
  value       = aws_kms_key.container_artifacts.arn
}

output "container_execution_dashboard_name" {
  description = "CloudWatch dashboard for container execution smoke and failure signals"
  value       = aws_cloudwatch_dashboard.container_execution.dashboard_name
}
