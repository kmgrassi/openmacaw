locals {
  ecs_tasks_assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role" "executor_execution" {
  name               = "${local.name_prefix}-executor-execution"
  assume_role_policy = local.ecs_tasks_assume_role_policy
}

resource "aws_iam_role_policy_attachment" "executor_execution_base" {
  role       = aws_iam_role.executor_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "executor_execution_secrets" {
  count = length(local.allowed_secret_arns) > 0 ? 1 : 0

  name = "${local.name_prefix}-executor-secret-injection"
  role = aws_iam_role.executor_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "ssm:GetParameter",
          "ssm:GetParameters",
        ]
        Resource = local.allowed_secret_arns
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.container_secrets.arn
      }
    ]
  })
}

resource "aws_iam_role" "executor_task" {
  name               = "${local.name_prefix}-executor-task"
  assume_role_policy = local.ecs_tasks_assume_role_policy
}

resource "aws_iam_role_policy" "executor_task_artifacts" {
  name = "${local.name_prefix}-executor-artifacts"
  role = aws_iam_role.executor_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteRunArtifacts"
        Effect = "Allow"
        Action = [
          "s3:AbortMultipartUpload",
          "s3:PutObject",
          "s3:PutObjectTagging",
        ]
        Resource = "${local.artifact_bucket_arn}/${local.artifact_write_prefix}/*"
      },
      {
        Sid    = "ReadOwnRunArtifacts"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectTagging",
        ]
        Resource = "${local.artifact_bucket_arn}/${local.artifact_write_prefix}/*"
      },
      {
        Sid      = "ListArtifactPrefix"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = local.artifact_bucket_arn
        Condition = {
          StringLike = {
            "s3:prefix" = [
              "${local.artifact_write_prefix}/*",
            ]
          }
        }
      },
      {
        Sid    = "EncryptArtifacts"
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey",
          "kms:Encrypt",
          "kms:GenerateDataKey",
        ]
        Resource = local.artifact_kms_key_arn
      }
    ]
  })
}

resource "aws_iam_role_policy" "executor_task_secrets" {
  count = length(local.allowed_secret_arns) > 0 ? 1 : 0

  name = "${local.name_prefix}-executor-resource-secrets"
  role = aws_iam_role.executor_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "secretsmanager:GetSecretValue",
          "ssm:GetParameter",
          "ssm:GetParameters",
        ]
        Resource = local.allowed_secret_arns
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Decrypt",
          "kms:DescribeKey",
        ]
        Resource = aws_kms_key.container_secrets.arn
      }
    ]
  })
}
