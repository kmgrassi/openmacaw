resource "aws_security_group" "repository_cache_efs" {
  name        = "${local.name_prefix}-repository-cache-efs"
  description = "NFS access boundary for container execution repository cache"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${local.name_prefix}-repository-cache-efs"
  }
}

resource "aws_security_group_rule" "repository_cache_efs_from_execution_tasks" {
  for_each = toset(var.execution_task_security_group_ids)

  type                     = "ingress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = aws_security_group.repository_cache_efs.id
  source_security_group_id = each.value
  description              = "Allow executor tasks to mount repository cache EFS"
}

resource "aws_security_group_rule" "repository_cache_efs_from_cleanup_task" {
  count = local.create_cleanup_resources ? 1 : 0

  type                     = "ingress"
  from_port                = 2049
  to_port                  = 2049
  protocol                 = "tcp"
  security_group_id        = aws_security_group.repository_cache_efs.id
  source_security_group_id = aws_security_group.cleanup_task[0].id
  description              = "Allow scheduled cleanup task to mount repository cache EFS"
}

resource "aws_security_group_rule" "repository_cache_efs_from_cidr" {
  count = length(var.allowed_nfs_cidr_blocks) > 0 ? 1 : 0

  type              = "ingress"
  from_port         = 2049
  to_port           = 2049
  protocol          = "tcp"
  security_group_id = aws_security_group.repository_cache_efs.id
  cidr_blocks       = var.allowed_nfs_cidr_blocks
  description       = "Allow explicit CIDR ranges to mount repository cache EFS"
}

resource "aws_efs_file_system" "repository_cache" {
  creation_token                  = "${local.name_prefix}-repository-cache"
  encrypted                       = true
  performance_mode                = var.efs_performance_mode
  throughput_mode                 = var.efs_throughput_mode
  provisioned_throughput_in_mibps = var.efs_provisioned_throughput_in_mibps

  lifecycle_policy {
    transition_to_ia = var.efs_transition_to_ia
  }

  tags = {
    Name = "${local.name_prefix}-repository-cache"
  }
}

resource "aws_efs_mount_target" "repository_cache" {
  for_each = toset(var.private_subnet_ids)

  file_system_id  = aws_efs_file_system.repository_cache.id
  subnet_id       = each.value
  security_groups = [aws_security_group.repository_cache_efs.id]
}

resource "aws_efs_access_point" "repository_mirrors" {
  file_system_id = aws_efs_file_system.repository_cache.id

  posix_user {
    uid = var.cache_posix_uid
    gid = var.cache_posix_gid
  }

  root_directory {
    path = var.repository_cache_root

    creation_info {
      owner_uid   = var.cache_posix_uid
      owner_gid   = var.cache_posix_gid
      permissions = "0750"
    }
  }

  tags = {
    Name = "${local.name_prefix}-repository-mirrors"
  }
}

resource "aws_efs_access_point" "session_workspaces" {
  file_system_id = aws_efs_file_system.repository_cache.id

  posix_user {
    uid = var.cache_posix_uid
    gid = var.cache_posix_gid
  }

  root_directory {
    path = var.session_workspace_root

    creation_info {
      owner_uid   = var.cache_posix_uid
      owner_gid   = var.cache_posix_gid
      permissions = "0750"
    }
  }

  tags = {
    Name = "${local.name_prefix}-session-workspaces"
  }
}
