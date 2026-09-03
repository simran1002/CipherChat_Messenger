package com.cipherchat.shared.kafka;

import java.time.Duration;
import java.util.concurrent.TimeUnit;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.DescribeClusterResult;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.HealthIndicator;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.stereotype.Component;

/**
 * Reports broker reachability under {@code /actuator/health} as {@code kafka}.
 * It is intentionally excluded from the readiness group: a send does not
 * need Kafka (publications wait in the outbox), so a broker outage must not
 * pull instances out of the load balancer — but operators must be able to
 * see it, and alert on it, before the outbox backlog becomes a problem.
 */
@Component("kafka")
public class KafkaHealthIndicator implements HealthIndicator {

    private static final Duration TIMEOUT = Duration.ofSeconds(3);

    private final KafkaAdmin admin;

    public KafkaHealthIndicator(KafkaAdmin admin) {
        this.admin = admin;
    }

    @Override
    public Health health() {
        try (AdminClient client = AdminClient.create(admin.getConfigurationProperties())) {
            DescribeClusterResult cluster = client.describeCluster();
            int nodes = cluster.nodes().get(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS).size();
            String clusterId = cluster.clusterId().get(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
            return Health.up().withDetail("clusterId", clusterId).withDetail("nodes", nodes).build();
        } catch (Exception e) {
            return Health.down().withDetail("error", e.getClass().getSimpleName() + ": " + e.getMessage()).build();
        }
    }
}
