package com.cipherchat.shared.kafka;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.apache.kafka.common.header.Headers;
import org.apache.kafka.common.header.internals.RecordHeaders;
import org.junit.jupiter.api.Test;
import org.springframework.kafka.support.serializer.JacksonJsonDeserializer;
import org.springframework.kafka.support.serializer.JacksonJsonSerializer;

import com.cipherchat.shared.events.MessagingEvents.MessageSent;

/**
 * The wire format between the outbox producer and the consumer groups, exercised without a
 * broker: the same serializer and deserializer classes and properties as application.yaml.
 * A mismatch here is what silently dead-letters every event in production.
 */
class EventWireFormatTest {

    @Test
    @SuppressWarnings({"unchecked", "rawtypes"})
    void producerBytesRoundTripThroughTheConsumerDeserializer() {
        MessageSent event = new MessageSent(UUID.randomUUID(), Instant.now(), UUID.randomUUID(), 42L, 7L,
                UUID.randomUUID(), "Alice", "hello", List.of(UUID.randomUUID()));

        Headers headers = new RecordHeaders();
        byte[] bytes;
        try (JacksonJsonSerializer<Object> serializer = new JacksonJsonSerializer<>()) {
            serializer.configure(Map.of(), false);
            bytes = serializer.serialize("message-events", headers, event);
        }
        assertThat(headers.lastHeader("__TypeId__")).as("type header written by the producer").isNotNull();

        try (JacksonJsonDeserializer deserializer = new JacksonJsonDeserializer<>()) {
            deserializer.configure(Map.of("spring.json.trusted.packages", "com.cipherchat.shared.events"), false);
            Object back = deserializer.deserialize("message-events", headers, bytes);
            assertThat(back).isInstanceOf(MessageSent.class);
            assertThat(((MessageSent) back).eventId()).isEqualTo(event.eventId());
            assertThat(((MessageSent) back).mentions()).isEqualTo(event.mentions());
        }
    }
}
