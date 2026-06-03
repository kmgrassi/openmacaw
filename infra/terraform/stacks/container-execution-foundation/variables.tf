variable "project_name" {
  description = "Project identifier used in resource naming"
  type        = string
  default     = "openmacaw"
}

variable "environment" {
  description = "Deployment environment (dev, staging, prod)"
  type        = string
  default     = "dev"
}

variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "vpc_id" {
  description = "VPC where execution resources run"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets for container execution tasks"
  type        = list(string)
}

variable "endpoint_security_group_id" {
  description = "Optional existing security group for interface VPC endpoints"
  type        = string
  default     = ""

  validation {
    condition     = var.create_vpc_endpoints ? var.endpoint_security_group_id != "" : true
    error_message = "endpoint_security_group_id must be provided when create_vpc_endpoints is true."
  }
}

variable "create_vpc_endpoints" {
  description = "Whether to create VPC interface endpoints for execution dependencies"
  type        = bool
  default     = true
}

variable "artifact_retention_days" {
  description = "Number of days to retain container execution artifacts before lifecycle expiration"
  type        = number
  default     = 30

  validation {
    condition     = var.artifact_retention_days > 0
    error_message = "artifact_retention_days must be greater than zero."
  }
}
