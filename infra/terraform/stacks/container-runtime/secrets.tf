resource "aws_kms_key" "container_secrets" {
  description             = "KMS key for ${local.name_prefix} container execution secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "container_secrets" {
  name          = "alias/${local.name_prefix}-container-secrets"
  target_key_id = aws_kms_key.container_secrets.key_id
}

resource "aws_secretsmanager_secret" "smoke" {
  name = "${local.secret_path_root}/workspaces/${var.secret_smoke_workspace_id}/runs/${var.secret_smoke_run_id}/smoke"

  description             = "Smoke-test secret for container execution secret isolation checks"
  kms_key_id              = aws_kms_key.container_secrets.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "smoke" {
  secret_id     = aws_secretsmanager_secret.smoke.id
  secret_string = "container-execution-smoke-ok"
}
