locals {
  step_functions_ecs_events_rule_arn = "arn:${data.aws_partition.current.partition}:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/StepFunctionsGetEventsForECSTaskRule"
}

resource "aws_iam_role" "executor_lifecycle_state_machine" {
  name = "${local.name_prefix}-executor-lifecycle-sfn"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "states.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "executor_lifecycle_state_machine" {
  name = "${local.name_prefix}-executor-lifecycle"
  role = aws_iam_role.executor_lifecycle_state_machine.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "RunExecutorTask"
        Effect = "Allow"
        Action = [
          "ecs:RunTask",
        ]
        Resource = aws_ecs_task_definition.executor.arn
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.ecs_cluster_arn
          }
        }
      },
      {
        Sid    = "ObserveAndStopExecutorTask"
        Effect = "Allow"
        Action = [
          "ecs:DescribeTasks",
          "ecs:StopTask",
        ]
        Resource = "*"
        Condition = {
          ArnEquals = {
            "ecs:cluster" = var.ecs_cluster_arn
          }
        }
      },
      {
        Sid    = "PassExecutorRoles"
        Effect = "Allow"
        Action = [
          "iam:PassRole",
        ]
        Resource = [
          aws_iam_role.executor_execution.arn,
          aws_iam_role.executor_task.arn,
        ]
        Condition = {
          StringEquals = {
            "iam:PassedToService" = "ecs-tasks.amazonaws.com"
          }
        }
      },
      {
        Sid    = "ManageEcsSyncEventsRule"
        Effect = "Allow"
        Action = [
          "events:DescribeRule",
          "events:PutRule",
          "events:PutTargets",
        ]
        Resource = local.step_functions_ecs_events_rule_arn
      }
    ]
  })
}

resource "aws_sfn_state_machine" "executor_lifecycle" {
  name     = "${local.name_prefix}-executor-lifecycle"
  role_arn = aws_iam_role.executor_lifecycle_state_machine.arn
  type     = "STANDARD"

  definition = jsonencode({
    Comment = "Owns the container executor RunTask lifecycle and relies on Step Functions ECS integration to stop tasks when executions are stopped."
    StartAt = "RunExecutorTask"
    States = {
      RunExecutorTask = {
        Type           = "Task"
        Resource       = "arn:${data.aws_partition.current.partition}:states:::ecs:runTask.sync"
        TimeoutSeconds = var.state_machine_task_timeout_seconds
        Parameters = {
          Cluster        = var.ecs_cluster_arn
          TaskDefinition = aws_ecs_task_definition.executor.arn
          LaunchType     = "FARGATE"
          Overrides = {
            "ContainerOverrides.$" = "$.containerOverrides"
          }
          NetworkConfiguration = {
            AwsvpcConfiguration = {
              AssignPublicIp = "DISABLED"
              SecurityGroups = [
                aws_security_group.executor_tasks.id,
              ]
              Subnets = var.private_subnet_ids
            }
          }
        }
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "LifecycleFailed"
        }]
        Next = "CheckExecutorExit"
      }
      CheckExecutorExit = {
        Type = "Choice"
        Choices = [
          {
            And = [
              {
                Variable  = "$.Tasks[0].Containers[0].ExitCode"
                IsPresent = true
              },
              {
                Variable      = "$.Tasks[0].Containers[0].ExitCode"
                NumericEquals = 0
              }
            ]
            Next = "LifecycleSucceeded"
          }
        ]
        Default = "LifecycleFailed"
      }
      LifecycleSucceeded = {
        Type = "Succeed"
      }
      LifecycleFailed = {
        Type  = "Fail"
        Cause = "Container executor lifecycle failed"
      }
    }
  })

  tags = {
    Name = "${local.name_prefix}-executor-lifecycle"
  }
}
