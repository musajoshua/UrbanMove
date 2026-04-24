# --- DB Subnet Group ---

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnet-group"
  subnet_ids = aws_subnet.data[*].id

  tags = {
    Name = "${local.name_prefix}-db-subnet-group"
  }
}

# --- RDS Security Group ---

resource "aws_security_group" "rds" {
  name_prefix = "${local.name_prefix}-rds-"
  description = "RDS PostgreSQL security group - only EKS workers on 5432"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-rds-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "rds_ingress_eks" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = aws_security_group.eks_workers.id
  description              = "Allow PostgreSQL from EKS workers"
}

resource "aws_security_group_rule" "rds_ingress_eks_cluster" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  description              = "Allow PostgreSQL from EKS managed node group"
}

resource "aws_security_group_rule" "rds_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.rds.id
  cidr_blocks       = [var.vpc_cidr]
  description       = "Allow egress within VPC only"
}

# --- RDS PostgreSQL Instance ---

resource "aws_db_instance" "main" {
  identifier = "${local.name_prefix}-postgres"

  engine               = "postgres"
  engine_version       = "16"
  instance_class       = var.rds_instance_class
  allocated_storage    = var.rds_allocated_storage
  max_allocated_storage = var.rds_allocated_storage * 2

  db_name  = var.rds_db_name
  username = var.rds_db_username
  password = var.rds_db_password

  multi_az               = false
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  storage_encrypted = true
  kms_key_id        = aws_kms_key.main.arn

  backup_retention_period   = 1
  backup_window             = "03:00-04:00"
  maintenance_window        = "sun:04:30-sun:05:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = false
  skip_final_snapshot       = true
  final_snapshot_identifier = "${local.name_prefix}-postgres-final"

  performance_insights_enabled = false

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  tags = {
    Name = "${local.name_prefix}-postgres"
  }
}

# --- RDS Snapshot Export to S3 ---

resource "aws_iam_role" "rds_s3_export" {
  name = "${local.name_prefix}-rds-s3-export-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "export.rds.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy" "rds_s3_export" {
  name = "${local.name_prefix}-rds-s3-export-policy"
  role = aws_iam_role.rds_s3_export.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetBucketLocation",
          "s3:ListBucket",
        ]
        Resource = [
          aws_s3_bucket.backups.arn,
          "${aws_s3_bucket.backups.arn}/rds-exports/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "kms:Encrypt",
          "kms:Decrypt",
          "kms:GenerateDataKey",
          "kms:DescribeKey",
        ]
        Resource = [aws_kms_key.main.arn]
      },
    ]
  })
}
