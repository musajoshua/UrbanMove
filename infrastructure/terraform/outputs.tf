# --- VPC ---

output "vpc_id" {
  description = "ID of the VPC"
  value       = aws_vpc.main.id
}

output "public_subnet_ids" {
  description = "IDs of the public subnets"
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets (EKS workers)"
  value       = aws_subnet.private[*].id
}

output "data_subnet_ids" {
  description = "IDs of the private data subnets (RDS, ElastiCache)"
  value       = aws_subnet.data[*].id
}

# --- EKS ---

output "eks_cluster_endpoint" {
  description = "Endpoint for the EKS cluster API server"
  value       = aws_eks_cluster.main.endpoint
}

output "eks_cluster_name" {
  description = "Name of the EKS cluster"
  value       = aws_eks_cluster.main.name
}

output "eks_oidc_provider_arn" {
  description = "ARN of the OIDC provider for IRSA"
  value       = aws_iam_openid_connect_provider.eks.arn
}

output "eks_cluster_certificate_authority" {
  description = "Base64-encoded certificate authority data for the cluster"
  value       = aws_eks_cluster.main.certificate_authority[0].data
  sensitive   = true
}

# --- RDS ---

output "rds_endpoint" {
  description = "Connection endpoint for the RDS PostgreSQL instance"
  value       = aws_db_instance.main.endpoint
}

output "rds_database_name" {
  description = "Name of the default database"
  value       = aws_db_instance.main.db_name
}

# --- ElastiCache ---

output "elasticache_endpoint" {
  description = "Primary endpoint for the Redis replication group"
  value       = aws_elasticache_replication_group.main.primary_endpoint_address
}

output "elasticache_port" {
  description = "Port for the Redis cluster"
  value       = aws_elasticache_replication_group.main.port
}

# --- ALB ---

output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Route53 zone ID of the ALB (for alias records)"
  value       = aws_lb.main.zone_id
}

# --- ECR ---

output "ecr_repository_urls" {
  description = "Map of service name to ECR repository URL"
  value       = { for k, v in aws_ecr_repository.services : k => v.repository_url }
}

# --- S3 ---

output "backup_bucket_name" {
  description = "Name of the S3 bucket for database backups"
  value       = aws_s3_bucket.backups.id
}

output "backup_bucket_arn" {
  description = "ARN of the S3 backup bucket"
  value       = aws_s3_bucket.backups.arn
}

# --- KMS ---

output "kms_key_arn" {
  description = "ARN of the KMS key used for encryption"
  value       = aws_kms_key.main.arn
}
