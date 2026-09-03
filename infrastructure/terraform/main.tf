# CipherChat on AWS — reference infrastructure.
#
# Scope: the managed services the application needs (network, EKS, Postgres,
# Redis, Kafka, object storage, secrets, IAM for IRSA). It is a complete,
# apply-able skeleton with production-shaped defaults (Multi-AZ, encryption,
# private subnets); sizes are the smallest sensible tier and are meant to be
# overridden per environment via *.tfvars. Not applied from this repository's
# CI — see docs/DEPLOYMENT.md for the promotion flow.

terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
  # backend "s3" {
  #   bucket         = "cipherchat-tfstate"
  #   key            = "prod/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "cipherchat-tflock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Project     = "cipherchat"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

locals {
  name = "cipherchat-${var.environment}"
}

# ── Network ──────────────────────────────────────────────────────────────────
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.8"

  name = local.name
  cidr = var.vpc_cidr
  azs  = var.azs

  private_subnets  = [for i, az in var.azs : cidrsubnet(var.vpc_cidr, 4, i)]
  public_subnets   = [for i, az in var.azs : cidrsubnet(var.vpc_cidr, 4, i + 8)]
  database_subnets = [for i, az in var.azs : cidrsubnet(var.vpc_cidr, 4, i + 12)]

  enable_nat_gateway     = true
  single_nat_gateway     = var.environment != "prod"
  one_nat_gateway_per_az = var.environment == "prod"
  enable_dns_hostnames   = true

  # ALB controller + cluster autoscaler discovery
  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }
}

# ── Kubernetes ───────────────────────────────────────────────────────────────
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.20"

  cluster_name    = local.name
  cluster_version = var.eks_version

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  cluster_endpoint_public_access = true
  enable_irsa                    = true          # pods assume IAM roles via OIDC — no static keys

  cluster_addons = {
    coredns    = {}
    kube-proxy = {}
    vpc-cni    = {}
  }

  eks_managed_node_groups = {
    general = {
      instance_types = var.node_instance_types
      min_size       = var.node_min
      max_size       = var.node_max
      desired_size   = var.node_min
      capacity_type  = var.environment == "prod" ? "ON_DEMAND" : "SPOT"
    }
  }
}

# ── PostgreSQL (RDS) ─────────────────────────────────────────────────────────
resource "aws_db_subnet_group" "db" {
  name       = local.name
  subnet_ids = module.vpc.database_subnets
}

resource "aws_security_group" "db" {
  name   = "${local.name}-db"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_instance" "postgres" {
  identifier              = local.name
  engine                  = "postgres"
  engine_version          = "17"
  instance_class          = var.db_instance_class
  allocated_storage       = 50
  max_allocated_storage   = 500
  storage_encrypted       = true
  db_name                 = "cipherchat"
  username                = "cipherchat"
  manage_master_user_password = true            # password lives in Secrets Manager, never in state
  db_subnet_group_name    = aws_db_subnet_group.db.name
  vpc_security_group_ids  = [aws_security_group.db.id]
  multi_az                = var.environment == "prod"
  backup_retention_period = var.environment == "prod" ? 14 : 1
  deletion_protection     = var.environment == "prod"
  skip_final_snapshot     = var.environment != "prod"
  performance_insights_enabled = true
  parameter_group_name    = aws_db_parameter_group.postgres.name
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${local.name}-pg17"
  family = "postgres17"
  # Connection budget: HikariCP pool (DB_POOL_SIZE) × max pods must stay under this.
  parameter {
    name  = "max_connections"
    value = "400"
    apply_method = "pending-reboot"
  }
}

# ── Redis (ElastiCache) ──────────────────────────────────────────────────────
resource "aws_elasticache_subnet_group" "redis" {
  name       = local.name
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "redis" {
  name   = "${local.name}-redis"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = local.name
  description          = "CipherChat presence, rate limits, sequences, WS fan-out"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_node_type
  num_cache_clusters   = var.environment == "prod" ? 2 : 1
  automatic_failover_enabled = var.environment == "prod"
  multi_az_enabled           = var.environment == "prod"
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  subnet_group_name    = aws_elasticache_subnet_group.redis.name
  security_group_ids   = [aws_security_group.redis.id]
  parameter_group_name = "default.redis7"
}

# ── Kafka (MSK) ──────────────────────────────────────────────────────────────
resource "aws_security_group" "kafka" {
  name   = "${local.name}-kafka"
  vpc_id = module.vpc.vpc_id
  ingress {
    from_port       = 9092
    to_port         = 9098
    protocol        = "tcp"
    security_groups = [module.eks.node_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_msk_cluster" "kafka" {
  cluster_name           = local.name
  kafka_version          = "3.7.x"
  number_of_broker_nodes = length(var.azs)          # one broker per AZ → replication factor 3

  broker_node_group_info {
    instance_type   = var.kafka_instance_type
    client_subnets  = module.vpc.private_subnets
    security_groups = [aws_security_group.kafka.id]
    storage_info {
      ebs_storage_info {
        volume_size = 100
      }
    }
  }

  encryption_info {
    encryption_in_transit {
      client_broker = "TLS_PLAINTEXT"             # PLAINTEXT inside the VPC for the app; TLS available
      in_cluster    = true
    }
  }

  configuration_info {
    arn      = aws_msk_configuration.kafka.arn
    revision = aws_msk_configuration.kafka.latest_revision
  }

  open_monitoring {
    prometheus {
      jmx_exporter { enabled_in_broker = true }
      node_exporter { enabled_in_broker = true }
    }
  }
}

resource "aws_msk_configuration" "kafka" {
  name           = "${local.name}-config"
  kafka_versions = ["3.7.x"]
  server_properties = <<-PROPERTIES
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
    num.partitions=12
    log.retention.hours=168
  PROPERTIES
}

# ── Uploads bucket + IRSA role ───────────────────────────────────────────────
resource "aws_s3_bucket" "uploads" {
  bucket = "${local.name}-uploads"
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  # Presigned PUTs come straight from the browser (E2EE attachments never transit the app).
  cors_rule {
    allowed_methods = ["PUT", "GET"]
    allowed_origins = var.frontend_origins
    allowed_headers = ["Content-Type", "Content-Length"]
    max_age_seconds = 3000
  }
}

module "backend_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.44"

  role_name = "${local.name}-backend"
  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["cipherchat:cipherchat-backend"]
    }
  }
  role_policy_arns = {
    uploads = aws_iam_policy.uploads.arn
  }
}

resource "aws_iam_policy" "uploads" {
  name = "${local.name}-uploads-rw"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.uploads.arn}/uploads/*"
    }]
  })
}

# ── Application secrets ──────────────────────────────────────────────────────
resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_password" "seal" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name = "${local.name}/backend"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    JWT_SECRET  = random_password.jwt.result
    SEAL_SECRET = random_password.seal.result
  })
}
