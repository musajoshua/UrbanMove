terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.40, < 6.0.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0, < 5.0.0"
    }
  }

  # backend "s3" {
  #   bucket         = "urbanmove-terraform-state"
  #   key            = "infrastructure/terraform.tfstate"
  #   region         = "eu-west-3"
  #   dynamodb_table = "urbanmove-terraform-locks"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  common_tags = {
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  name_prefix = "${var.project_name}-${var.environment}"
}
