package com.cipherchat.shared.infra;

import java.util.concurrent.Executor;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.task.SimpleAsyncTaskExecutor;
import org.springframework.scheduling.annotation.AsyncConfigurer;

/**
 * Executor for {@code @Async} work, which is where Modulith's application-module listeners
 * (socket fan-out, Kafka externalization, completion bookkeeping) run.
 *
 * <p>Virtual threads are kept (they are the right tool for these short, blocking hops), but the
 * concurrency is capped. Boot's default virtual-thread executor is unbounded, so a burst of
 * events spawned one listener per event simultaneously and every one of them competed for the
 * 20-connection JDBC pool: REST requests then waited past the 5 s acquire timeout and failed
 * with 503 while the burst drained. With a cap, a burst queues in memory instead.
 */
@Configuration
public class AsyncConfig implements AsyncConfigurer {

    private final int concurrency;

    public AsyncConfig(@Value("${cipherchat.events.concurrency:64}") int concurrency) {
        this.concurrency = concurrency;
    }

    @Override
    public Executor getAsyncExecutor() {
        SimpleAsyncTaskExecutor executor = new SimpleAsyncTaskExecutor("events-");
        executor.setVirtualThreads(true);
        executor.setConcurrencyLimit(concurrency);
        executor.setTaskTerminationTimeout(10_000);
        return executor;
    }
}
