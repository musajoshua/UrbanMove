locals {
  ecr_repositories = [
    "auth-service",
    "ingestion-service",
    "analytics-service",
    "fleet-service",
    "user-api",
    "web-dashboard",
    "api-gateway",
  ]
}

resource "aws_ecr_repository" "services" {
  for_each = toset(local.ecr_repositories)

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }

  tags = {
    Name    = "${local.name_prefix}-${each.value}"
    Service = each.value
  }
}

resource "aws_ecr_lifecycle_policy" "services" {
  for_each = aws_ecr_repository.services

  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = {
        type = "expire"
      }
    }]
  })
}
