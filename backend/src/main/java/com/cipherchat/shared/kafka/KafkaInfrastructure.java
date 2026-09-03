package com.cipherchat.shared.kafka;

import java.util.Map;

import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.common.serialization.ByteArraySerializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.kafka.config.TopicBuilder;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaAdmin;
import org.springframework.kafka.core.KafkaOperations;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.listener.CommonErrorHandler;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.ExponentialBackOffWithMaxRetries;
import org.springframework.kafka.support.converter.MessagingMessageConverter;
import org.springframework.kafka.support.converter.RecordMessageConverter;
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
 *       {@code <topic>-dlt} with the exception in headers and the partition is
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

    /** Spring Kafka 4's DeadLetterPublishingRecoverer default suffix; the topics are pre-created with it below. */
    public static final String DLT_SUFFIX = "-dlt";

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

    /**
     * DLT publisher. A record that failed <em>deserialisation</em> arrives here as raw {@code byte[]}
     * (ErrorHandlingDeserializer keeps the original bytes); publishing it through the JSON template
     * would base64-wrap it into a JSON string and destroy the evidence, so raw values go through a
     * byte-array template and everything else through the normal JSON one.
     */
    @Bean
    CommonErrorHandler kafkaErrorHandler(KafkaOperations<Object, Object> template, ProducerFactory<Object, Object> producers) {
        Map<String, Object> rawProps = new java.util.HashMap<>(producers.getConfigurationProperties());
        rawProps.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class);
        rawProps.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, ByteArraySerializer.class);
        rawProps.remove(ProducerConfig.TRANSACTIONAL_ID_CONFIG);
        KafkaOperations<Object, Object> rawTemplate = new KafkaTemplate<>(new DefaultKafkaProducerFactory<>(rawProps));
        Map<Class<?>, KafkaOperations<?, ?>> templates = new java.util.LinkedHashMap<>();
        templates.put(byte[].class, rawTemplate);
        templates.put(Object.class, template);
        var recoverer = new DeadLetterPublishingRecoverer(templates);   // → <topic>-dlt, same partition
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

    /**
     * One wire format, end to end. spring-modulith-events-kafka contributes a
     * {@code ByteArrayJacksonJsonMessageConverter} bean for its own string-serialised path, and
     * Spring Boot wires whatever {@code RecordMessageConverter} bean exists into every listener
     * container and the KafkaTemplate. That converter refuses values the deserializer already
     * turned into typed records (it only accepts String or byte payloads) and dead-lettered
     * every event. The plain converter passes typed values straight through.
     */
    @Bean
    @Primary
    RecordMessageConverter recordMessageConverter() {
        return new MessagingMessageConverter();
    }

    @Bean
    EventExternalizationConfiguration eventExternalization() {
        return EventExternalizationConfiguration.defaults("com.cipherchat")
                .serializeExternalization(false)
                .headers(event -> Map.of("eventType", event.getClass().getSimpleName()))
                .build();
    }
}
