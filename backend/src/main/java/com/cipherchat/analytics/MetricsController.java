package com.cipherchat.analytics;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.TimeUnit;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.shared.infra.AppMetrics;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.distribution.ValueAtPercentile;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * JSON feed for the in-app metrics dashboard. THIS INSTANCE's numbers with a
 * rolling 10-minute history of snapshots — the right tool for a demo and a
 * quick health glance. Cluster-wide, long-retention views are Prometheus's
 * job ({@code /actuator/prometheus}); this endpoint deliberately does not
 * pretend otherwise.
 */
@RestController
@RequestMapping("/api/v1/analytics")
@Tag(name = "Analytics", description = "Content-free delivery metrics for the in-app dashboard")
public class MetricsController {

    public record LatencyStats(double p50, double p95, double p99, long samples) {
    }

    public record Concurrency(int current, int peak) {
    }

    public record Snapshot(long ts, long messageSent, long messageDelivered, long messageFailed, long duplicatesRejected,
                           long rateLimitHits, double deliveryRatePct, LatencyStats latency, Concurrency concurrency) {
    }

    public record Summary(long messageSent, long messageDelivered, long messageFailed, long duplicatesRejected,
                          long rateLimitHits, double deliveryRatePct, LatencyStats latency, Concurrency concurrency,
                          List<Snapshot> snapshots) {
    }

    private static final int HISTORY = 60;       // 60 × 10 s = 10 minutes

    private final AppMetrics metrics;
    private final MeterRegistry registry;
    private final Deque<Snapshot> history = new ArrayDeque<>();

    public MetricsController(AppMetrics metrics, MeterRegistry registry) {
        this.metrics = metrics;
        this.registry = registry;
    }

    @GetMapping("/metrics")
    @Operation(summary = "Current counters, latency percentiles, concurrency and a 10-minute snapshot history")
    public Summary metrics() {
        Snapshot now = snapshot();
        List<Snapshot> copy;
        synchronized (history) {
            copy = new ArrayList<>(history);
        }
        return new Summary(now.messageSent(), now.messageDelivered(), now.messageFailed(), now.duplicatesRejected(),
                now.rateLimitHits(), now.deliveryRatePct(), now.latency(), now.concurrency(), copy);
    }

    @Scheduled(fixedRateString = "PT10S")
    public void record() {
        Snapshot s = snapshot();
        synchronized (history) {
            history.addLast(s);
            while (history.size() > HISTORY) history.removeFirst();
        }
    }

    private Snapshot snapshot() {
        long sent = (long) metrics.sentCount();
        long failed = (long) metrics.failedCount();
        long delivered = (long) counter("cipherchat.receipts", "type", "delivered");
        double rate = sent + failed == 0 ? 100.0 : Math.round(sent * 10_000.0 / (sent + failed)) / 100.0;
        var timer = metrics.sendLatency();
        double p50 = 0, p95 = 0, p99 = 0;
        for (ValueAtPercentile v : timer.takeSnapshot().percentileValues()) {
            double ms = v.value(TimeUnit.MILLISECONDS);
            if (v.percentile() == 0.5) p50 = ms;
            else if (v.percentile() == 0.95) p95 = ms;
            else if (v.percentile() == 0.99) p99 = ms;
        }
        return new Snapshot(System.currentTimeMillis(), sent, delivered, failed, (long) metrics.duplicateCount(),
                (long) metrics.rateLimitCount(), rate,
                new LatencyStats(round(p50), round(p95), round(p99), timer.count()),
                new Concurrency(metrics.sessions(), metrics.sessionsPeak()));
    }

    private double counter(String name, String tagKey, String tagValue) {
        Counter c = registry.find(name).tag(tagKey, tagValue).counter();
        return c == null ? 0 : c.count();
    }

    private static double round(double v) {
        return Math.round(v * 100.0) / 100.0;
    }
}
