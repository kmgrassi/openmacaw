terraform {
  # 1.9.0+ is required for `removed { lifecycle { destroy = false } }` blocks
  # used in migrations.tf to detach the legacy ALB resources from state
  # without destroying any still-live AWS objects.
  required_version = ">= 1.9.0"

  backend "s3" {}

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
