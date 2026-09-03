# Values the Kubernetes ConfigMap / External Secrets need. Wire them with:
#   terraform output -json > ../kubernetes/tf-outputs.json
output "database_url" {
  value = "jdbc:postgresql://${aws_db_instance.postgres.address}:5432/cipherchat"
}

output "database_master_secret_arn" {
  description = "Secrets Manager ARN holding the RDS master credentials (username/password JSON)"
  value       = aws_db_instance.postgres.master_user_secret[0].secret_arn
}

output "redis_url" {
  value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379"
}

output "kafka_bootstrap_servers" {
  value = aws_msk_cluster.kafka.bootstrap_brokers
}

output "uploads_bucket" {
  value = aws_s3_bucket.uploads.bucket
}

output "backend_irsa_role_arn" {
  description = "Annotate the cipherchat-backend ServiceAccount with this"
  value       = module.backend_irsa.iam_role_arn
}

output "app_secret_arn" {
  description = "JWT_SECRET / SEAL_SECRET"
  value       = aws_secretsmanager_secret.app.arn
}

output "eks_cluster_name" {
  value = module.eks.cluster_name
}
