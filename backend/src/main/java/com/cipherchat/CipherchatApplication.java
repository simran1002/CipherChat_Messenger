package com.cipherchat;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.modulith.Modulithic;
import org.springframework.scheduling.annotation.EnableAsync;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * CipherChat — a modular monolith.
 *
 * Each direct sub-package of {@code com.cipherchat} is a Spring Modulith
 * application module with an enforced boundary (verified by
 * {@code ModularityTests}): {@code auth}, {@code user}, {@code chatroom},
 * {@code dm}, {@code presence}, {@code notification}, {@code keys},
 * {@code analytics}. {@code shared} is the shared kernel (ids, errors, events,
 * security principal) every module may depend on.
 *
 * Modules talk through published domain events, not direct service calls,
 * wherever the interaction is asynchronous by nature (a message was sent →
 * notify, audit, count). Those events are persisted in the event-publication
 * table inside the producing transaction and externalized to Kafka afterwards
 * — a transactional outbox, so a crash between "committed" and "published"
 * can never lose an event. This is the seam along which any module can later
 * be extracted into its own service without rewriting its callers.
 */
@SpringBootApplication
@Modulithic(sharedModules = "shared", systemName = "CipherChat")
@EnableScheduling
@EnableAsync
public class CipherchatApplication {

    public static void main(String[] args) {
        SpringApplication.run(CipherchatApplication.class, args);
    }
}
