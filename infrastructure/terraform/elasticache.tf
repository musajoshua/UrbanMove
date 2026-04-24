# --- ElastiCache Subnet Group ---

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnet-group"
  subnet_ids = aws_subnet.data[*].id

  tags = {
    Name = "${local.name_prefix}-redis-subnet-group"
  }
}

# --- ElastiCache Security Group ---

resource "aws_security_group" "redis" {
  name_prefix = "${local.name_prefix}-redis-"
  description = "ElastiCache Redis security group - only EKS workers on 6379"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-redis-sg"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "redis_ingress_eks" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_security_group.eks_workers.id
  description              = "Allow Redis from EKS workers"
}

resource "aws_security_group_rule" "redis_ingress_eks_cluster" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  security_group_id        = aws_security_group.redis.id
  source_security_group_id = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
  description              = "Allow Redis from EKS managed node group"
}

resource "aws_security_group_rule" "redis_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.redis.id
  cidr_blocks       = [var.vpc_cidr]
  description       = "Allow egress within VPC only"
}

# --- ElastiCache Redis Replication Group ---

resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name_prefix}-redis"
  description          = "UrbanMove Redis cluster for session and cache"

  node_type            = var.elasticache_node_type
  num_cache_clusters   = 1
  port                 = 6379
  parameter_group_name = "default.redis7"
  engine_version       = "7.0"

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.main.arn
  transit_encryption_enabled = true
  auth_token                 = var.redis_auth_token

  automatic_failover_enabled = false
  multi_az_enabled           = false

  snapshot_retention_limit = 7
  snapshot_window          = "03:00-05:00"
  maintenance_window       = "sun:05:00-sun:07:00"

  tags = {
    Name = "${local.name_prefix}-redis"
  }
}
