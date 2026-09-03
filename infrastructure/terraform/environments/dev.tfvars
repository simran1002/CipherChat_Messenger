environment         = "dev"
node_instance_types = ["t3.large"]
node_min            = 1
node_max            = 3
db_instance_class   = "db.t4g.small"
redis_node_type     = "cache.t4g.micro"
kafka_instance_type = "kafka.t3.small"
frontend_origins    = ["http://localhost:3000", "https://dev.chat.example.com"]
