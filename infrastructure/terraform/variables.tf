variable "region" {
  description = "AWS region for all resources"
  type        = string
  default     = "eu-west-3"
}

variable "project_name" {
  description = "Project name used in resource naming and tagging"
  type        = string
  default     = "urbanmove"
}

variable "environment" {
  description = "Deployment environment (staging, production)"
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Environment must be 'staging' or 'production'."
  }
}

# --- VPC ---

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0))
    error_message = "Must be a valid CIDR block."
  }
}

# --- EKS ---

variable "eks_cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
  default     = "urbanmove-cluster"
}

variable "eks_node_instance_type" {
  description = "EC2 instance type for EKS worker nodes"
  type        = string
  default     = "t3.large"
}

variable "eks_node_desired_count" {
  description = "Desired number of EKS worker nodes"
  type        = number
  default     = 3
}

variable "eks_node_min_count" {
  description = "Minimum number of EKS worker nodes"
  type        = number
  default     = 2
}

variable "eks_node_max_count" {
  description = "Maximum number of EKS worker nodes"
  type        = number
  default     = 5
}

# --- RDS ---

variable "rds_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.r6g.large"
}

variable "rds_allocated_storage" {
  description = "Allocated storage in GB for RDS"
  type        = number
  default     = 100
}

variable "rds_db_name" {
  description = "Name of the default database"
  type        = string
  default     = "urbanmove"
}

variable "rds_db_username" {
  description = "Master username for the RDS instance"
  type        = string
  sensitive   = true
}

variable "rds_db_password" {
  description = "Master password for the RDS instance"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.rds_db_password) >= 16
    error_message = "Database password must be at least 16 characters."
  }
}

# --- ElastiCache ---

variable "elasticache_node_type" {
  description = "ElastiCache node type"
  type        = string
  default     = "cache.r6g.large"
}

variable "redis_auth_token" {
  description = "Auth token for Redis in-transit encryption"
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.redis_auth_token) >= 16
    error_message = "Redis auth token must be at least 16 characters."
  }
}

# --- Security ---

variable "jwt_secret" {
  description = "JWT signing secret for application auth"
  type        = string
  sensitive   = true
}

variable "domain_name" {
  description = "Domain name for ACM certificate"
  type        = string
  default     = "urbanmove.example.com"
}
