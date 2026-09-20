package com.cipherchat.shared.kafka;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.boot.health.contributor.Health;
import org.springframework.boot.health.contributor.Status;
import org.springframework.kafka.core.KafkaAdmin;

class KafkaHealthIndicatorTest {

    /**
     * With the broker down the probe must answer DOWN promptly. It used to take a full minute: the AdminClient's
     * implicit close() waited out Kafka's 60 s default API timeout, so /actuator/health hung precisely when an
     * operator (or a load balancer polling it) needed an answer. Nothing listens on port 1.
     */
    @Test
    void anUnreachableBrokerIsReportedDownWithinSeconds_notAMinute() {
        var indicator = new KafkaHealthIndicator(new KafkaAdmin(Map.of("bootstrap.servers", "localhost:1")));

        long started = System.nanoTime();
        Health health = indicator.health();
        Duration took = Duration.ofNanos(System.nanoTime() - started);

        assertThat(health.getStatus()).isEqualTo(Status.DOWN);
        assertThat(health.getDetails()).containsKey("error");
        assertThat(took).as("time to report DOWN").isLessThan(Duration.ofSeconds(10));
    }
}
