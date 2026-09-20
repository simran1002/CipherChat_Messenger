package com.cipherchat.shared.kafka;

import java.time.Duration;
import java.util.concurrent.TimeUnit;

import org.apache.kafka.clients.admin.AdminClient;
import org.apache.kafka.clients.admin.DescribeClusterOptions;
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
    /** How long close() may wait for in-flight calls. Zero-ish: a health probe must never outlive its own timeout. */
    private static final Duration CLOSE_GRACE = Duration.ofMillis(200);

    private final KafkaAdmin admin;

    public KafkaHealthIndicator(KafkaAdmin admin) {
        this.admin = admin;
    }

    @Override
    public Health health() {
        // Not try-with-resources: its implicit close() waits for pending calls for Kafka's default.api.timeout.ms
        // (60 s) when the broker is unreachable, so a 3 s probe took a full minute to answer DOWN — exactly when
        // an operator is looking at it. Bound both the call itself and the close.
        AdminClient client = AdminClient.create(admin.getConfigurationProperties());
        try {
            DescribeClusterResult cluster = client.describeCluster(new DescribeClusterOptions().timeoutMs((int) TIMEOUT.toMillis()));
            int nodes = cluster.nodes().get(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS).size();
            String clusterId = cluster.clusterId().get(TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
            return Health.up().withDetail("clusterId", clusterId).withDetail("nodes", nodes).build();
        } catch (Exception e) {
            return Health.down().withDetail("error", e.getClass().getSimpleName() + ": " + e.getMessage()).build();
        } finally {
            client.close(CLOSE_GRACE);
        }
    }
}
