package com.cipherchat.gateway;

import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.springframework.stereotype.Component;

import com.cipherchat.presence.PresenceService;

/**
 * Throttled roster broadcast: fire immediately when idle, coalesce every
 * request during the cooldown into ONE trailing broadcast. Per instance —
 * each replica publishes its own (identical, Redis-derived) roster at most
 * once a second regardless of connect churn.
 *
 * <p>The same-tick race the unit tests of the previous implementation
 * caught is closed here by construction: {@code inFlight} is a CAS, so a
 * burst of synchronous requests can never each start a send.
 */
@Component
public class RosterBroadcaster {

    private static final long COOLDOWN_MS = 1000;

    private final PresenceService presence;
    private final RedisFanout fanout;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean inFlight = new AtomicBoolean(false);
    private volatile boolean dirty;
    private volatile ScheduledFuture<?> cooldown;

    public RosterBroadcaster(PresenceService presence, RedisFanout fanout) {
        this.presence = presence;
        this.fanout = fanout;
        this.scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "roster-broadcast");
            t.setDaemon(true);
            return t;
        });
    }

    public void request() {
        if (!inFlight.compareAndSet(false, true)) {
            dirty = true;
            return;
        }
        fire();
    }

    private void fire() {
        dirty = false;
        try {
            fanout.toAll("onlineUsers", presence.roster());
        } finally {
            cooldown = scheduler.schedule(() -> {
                inFlight.set(false);
                if (dirty) request();
            }, COOLDOWN_MS, TimeUnit.MILLISECONDS);
        }
    }

    @jakarta.annotation.PreDestroy
    void shutdown() {
        if (cooldown != null) cooldown.cancel(false);
        scheduler.shutdownNow();
    }
}
