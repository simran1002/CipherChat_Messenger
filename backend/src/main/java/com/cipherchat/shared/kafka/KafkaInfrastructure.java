package com.cipherchat.shared.kafka;

import java.util.Map;

import org.apache.kafka.clients.admin.NewTopic;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.listener.CommonErrorHandler;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.ExponentialBackOffWithMaxRetries;
import org.springframework.modulith.events.EventExternalizationConfiguration;

import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.events.AuditEvents;
import com.cipherchat.shared.events.MessagingEvents;

/**
 * Kafka topology and failure policy.
 *
 * <ul>
 *   <li><b>Topics</b> are declared here so every environment (Testcontainers,
 *       Compose, AWS MSK) gets identical partitioning. Partition count is the
 *       consumer-parallelism ceiling; keys are room / conversation ids so one
 *       conversation is always consumed in order.</li>
 *   <li><b>Retries</b>: exponential back-off, then the record is copied to
 *       {@code <topic>.DLT} with the exception in headers and the partition is
 *       released — a poison message never blocks its siblings.</li>
 *   <li><b>Serialization</b>: domain events are records; Spring Kafka's Jackson
 *       serializer writes them with a {@code __TypeId__} header so consumers
 *       get typed objects back and can dispatch with {@code @KafkaHandler}.
 *       Modulith's own serializer is bypassed ({@code serializeExternalization(false)})
 *       so there is exactly one wire format.</li>
 * </ul>
 */
@Configuration
public class KafkaInfrastructure {

    public static final String DLT_SUFFIX = ".DLT";

    @Bean
    KafkaAdmin.NewTopics topics(@Value("${cipherchat.kafka.partitions:6}") int partitions) {
        return new KafkaAdmin.NewTopics(
                topic(MessagingEvents.MESSAGE_EVENTS, partitions),
                topic(MessagingEvents.MESSAGE_EVENTS + DLT_SUFFIX, partitions),
                topic(MessagingEvents.PRESENCE_EVENTS, partitions),
                topic(MessagingEvents.PRESENCE_EVENTS + DLT_SUFFIX, partitions),
                topic(MessagingEvents.NOTIFICATION_EVENTS, partitions),
                topic(MessagingEvents.NOTIFICATION_EVENTS + DLT_SUFFIX, partitions),
                topic(AuditEvents.AUDIT_EVENTS, partitions),
                topic(AuditEvents.AUDIT_EVENTS + DLT_SUFFIX, partitions));
    }

    private static NewTopic topic(String name, int partitions) {
        // Replication factor deliberately omitted → broker default (1 locally, 3 on MSK).
        return TopicBuilder.name(name).partitions(partitions).build();
    }

    @Bean
    CommonErrorHandler kafkaErrorHandler(KafkaOperations<Object, Object> template) {
        var recoverer = new DeadLetterPublishingRecoverer(template);   // → <topic>.DLT, same partition
        var backOff = new ExponentialBackOffWithMaxRetries(4);          // 0.5s, 1s, 2s, 4s then DLT
        backOff.setInitialInterval(500);
        backOff.setMultiplier(2.0);
        backOff.setMaxInterval(8_000);
        var handler = new DefaultErrorHandler(recoverer, backOff);
        // Retrying can't fix a malformed or business-rejected record — straight to the DLT.
        handler.addNotRetryableExceptions(ApiException.class, IllegalArgumentException.class,
                tools.jackson.core.JacksonException.class);
        return handler;
    }

    @Bean
    EventExternalizationConfiguration eventExternalization() {
        return EventExternalizationConfiguration.defaults("com.cipherchat")
                .serializeExternalization(false)
                .headers(event -> Map.of("eventType", event.getClass().getSimpleName()))
                .build();
    }
}
