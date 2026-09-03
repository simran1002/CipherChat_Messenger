package com.cipherchat.shared.infra;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.stereotype.Component;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;

/**
 * Application-level metrics, content-free by construction: counts and
 * timings, never bodies. Registered once here so every module records into
 * the same meters and Prometheus scrapes them from {@code /actuator/prometheus}.
 *
 * <p>The send latency timer publishes p50/p95/p99 — the numbers the in-app
 * metrics dashboard shows — as pre-computed percentiles, not histograms:
 * this instance's view of its own request path, cheap to read on every poll.
 */
@Component
public class AppMetrics {

    private final Counter messagesSent;
    private final Counter messagesFailed;
    private final Counter duplicatesRejected;
    private final Counter rateLimitHits;
    private final Timer sendLatency;
    private final AtomicInteger wsSessions = new AtomicInteger();
    private final AtomicInteger wsSessionsPeak = new AtomicInteger();

    public AppMetrics(MeterRegistry registry) {
        messagesSent = Counter.builder("cipherchat.send.accepted").description("Messages persisted (rooms + DMs)").register(registry);
        messagesFailed = Counter.builder("cipherchat.send.failed").description("Sends rejected or errored").register(registry);
        duplicatesRejected = Counter.builder("cipherchat.send.duplicates").description("Client retries absorbed by dedup").register(registry);
        rateLimitHits = Counter.builder("cipherchat.ratelimit.hits").description("Requests refused by the token bucket").register(registry);
        sendLatency = Timer.builder("cipherchat.send.latency")
                .description("Send pipeline: validation → dedup → sequence → persist → outbox")
                .publishPercentiles(0.5, 0.95, 0.99)
                .minimumExpectedValue(Duration.ofMillis(1))
                .maximumExpectedValue(Duration.ofSeconds(5))
                .register(registry);
        Gauge.builder("cipherchat.ws.sessions", wsSessions, AtomicInteger::get)
                .description("Open STOMP sessions on this instance").register(registry);
        Gauge.builder("cipherchat.ws.sessions.peak", wsSessionsPeak, AtomicInteger::get)
                .description("Peak open STOMP sessions since start").register(registry);
    }

    public void sent() { messagesSent.increment(); }
    public void failed() { messagesFailed.increment(); }
    public void duplicate() { duplicatesRejected.increment(); }
    public void rateLimited() { rateLimitHits.increment(); }

    public Timer.Sample start() { return Timer.start(); }
    public void stop(Timer.Sample sample) { sample.stop(sendLatency); }

    public void sessionOpened() {
        int now = wsSessions.incrementAndGet();
        wsSessionsPeak.accumulateAndGet(now, Math::max);
    }

    public void sessionClosed() {
        wsSessions.updateAndGet(n -> Math.max(0, n - 1));
    }

    // ── read side (in-app dashboard) ─────────────────────────────────────────

    public double sentCount() { return messagesSent.count(); }
    public double failedCount() { return messagesFailed.count(); }
    public double duplicateCount() { return duplicatesRejected.count(); }
    public double rateLimitCount() { return rateLimitHits.count(); }
    public int sessions() { return wsSessions.get(); }
    public int sessionsPeak() { return wsSessionsPeak.get(); }
    public Timer sendLatency() { return sendLatency; }
}
