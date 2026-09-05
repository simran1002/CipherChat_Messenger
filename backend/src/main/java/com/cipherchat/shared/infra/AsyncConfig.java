package com.cipherchat.shared.infra;

import java.util.concurrent.Executor;
import java.util.concurrent.ThreadPoolExecutor;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.AsyncConfigurer;
import org.springframework.scheduling.concurrent.ThreadPoolTaskExecutor;

/**
 * Executor for {@code @Async} work, which is where Modulith's application-module listeners
 * (socket fan-out, Kafka externalization, completion bookkeeping) run.
 *
 * <p>Two constraints, both measured:
 * <ul>
 *   <li>It must be bounded. Boot's default virtual-thread executor is unbounded, so an event burst
 *       spawned one listener per event at once and every one of them competed for the 20-connection
 *       JDBC pool; REST requests then waited past the 5 s acquire timeout and failed with 503.</li>
 *   <li>It must never block the caller. AFTER_COMMIT listeners are dispatched on the committing
 *       thread before its connection is released; a throttled {@code SimpleAsyncTaskExecutor}
 *       blocks that thread when the limit is hit, so senders sat on pooled connections waiting for a
 *       listener slot while listeners waited for connections (Hikari active=20, pending=40, Postgres
 *       idle). A pool with a queue absorbs the burst in memory instead.</li>
 * </ul>
 */
@Configuration
public class AsyncConfig implements AsyncConfigurer {

    /** Bean name of the executor reserved for socket fan-out; never shared with externalization. */
    public static final String FANOUT_EXECUTOR = "fanoutExecutor";

    private final int maxThreads;
    private final int queueCapacity;

    public AsyncConfig(@Value("${cipherchat.events.concurrency:64}") int maxThreads,
                       @Value("${cipherchat.events.queue-capacity:50000}") int queueCapacity) {
        this.maxThreads = maxThreads;
        this.queueCapacity = queueCapacity;
    }

    /**
     * Socket fan-out only (Redis publish + at most one read). Isolated from the default event
     * executor so a Kafka stall in externalization can never delay a live broadcast.
     */
    @Bean(FANOUT_EXECUTOR)
    public Executor fanoutExecutor() {
        return build("fanout-", Math.min(8, maxThreads), Math.max(8, maxThreads / 2), queueCapacity);
    }

    @Override
    public Executor getAsyncExecutor() {
        return build("events-", Math.min(16, maxThreads), maxThreads, queueCapacity);
    }

    private static ThreadPoolTaskExecutor build(String prefix, int core, int max, int queue) {
        ThreadPoolTaskExecutor executor = new ThreadPoolTaskExecutor();
        executor.setThreadNamePrefix(prefix);
        executor.setCorePoolSize(core);
        executor.setMaxPoolSize(max);
        executor.setQueueCapacity(queue);
        executor.setAllowCoreThreadTimeOut(true);
        executor.setKeepAliveSeconds(30);
        // Only if the queue itself overflows: run inline rather than drop a fan-out or an externalization.
        executor.setRejectedExecutionHandler(new ThreadPoolExecutor.CallerRunsPolicy());
        executor.setWaitForTasksToCompleteOnShutdown(true);
        executor.setAwaitTerminationSeconds(10);
        executor.initialize();
        return executor;
    }
}
