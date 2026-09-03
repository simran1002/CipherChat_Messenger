package com.cipherchat.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Properties;
import java.util.UUID;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.clients.producer.KafkaProducer;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.header.Header;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.kafka.core.KafkaTemplate;
import org.testcontainers.kafka.KafkaContainer;

import com.cipherchat.AbstractIntegrationTest;
import com.cipherchat.shared.events.MessagingEvents.MessageSent;

/**
 * The at-least-once contract, exercised through a real broker:
 * <ol>
 *   <li>the same event delivered twice produces one side effect (ledger);</li>
 *   <li>a record that cannot be deserialised goes straight to the DLT and the
 *       partition moves on;</li>
 *   <li>a side effect that keeps failing is retried, then dead-lettered, and
 *       leaves no ledger row (the claim rolled back with the transaction).</li>
 * </ol>
 */
class KafkaResilienceIT extends AbstractIntegrationTest {

    @Autowired KafkaTemplate<Object, Object> kafka;
    @Autowired KafkaContainer kafkaContainer;
    @Autowired JdbcClient jdbc;
    @Value("${cipherchat.kafka.topics.message-events}") String messageEvents;

    @Test
    void duplicateDeliveryOfTheSameEventProducesOneNotification() {
        Session target = register("Dup Target");
        UUID eventId = UUID.randomUUID();
        long messageId = 900_000_000L + (long) (Math.random() * 1_000_000);
        MessageSent event = new MessageSent(eventId, Instant.now(), UUID.randomUUID(), messageId, 1,
                UUID.randomUUID(), "Producer", "hey @Dup", List.of(target.id()));

        // Two deliveries of one event — what a rebalance or a lost offset commit looks like.
        kafka.send(messageEvents, event.chatroomId().toString(), event);
        kafka.send(messageEvents, event.chatroomId().toString(), event);

        try {
            await().atMost(Duration.ofSeconds(45)).untilAsserted(() ->
                    assertThat(inboxRows(target.id(), messageId)).isEqualTo(1));
        } catch (AssertionError timeout) {
            // Surface why the consumer did not write the row: the DLT carries the exception headers.
            throw new AssertionError("No inbox row; DLT says: " + describe(awaitDlt(event.chatroomId().toString(), Duration.ofSeconds(10))), timeout);
        }
        // Give the second delivery every chance to misbehave, then confirm it did not.
        await().during(Duration.ofSeconds(4)).atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(inboxRows(target.id(), messageId)).isEqualTo(1));
        long claims = jdbc.sql("select count(*) from processed_events where consumer = 'notifications' and event_id = :e")
                .param("e", eventId).query(Long.class).single();
        assertThat(claims).isEqualTo(1);
    }

    @Test
    void aRecordThatCannotBeDeserialisedIsDeadLetteredWithoutRetries() {
        String marker = "poison-" + UUID.randomUUID();
        try (KafkaProducer<String, String> raw = rawProducer()) {
            ProducerRecord<String, String> record = new ProducerRecord<>(messageEvents, marker, "{ this is not json");
            record.headers().add("__TypeId__", MessageSent.class.getName().getBytes(StandardCharsets.UTF_8));
            raw.send(record);
            raw.flush();
        }
        ConsumerRecord<String, String> dead = awaitDlt(marker, Duration.ofSeconds(30));
        assertThat(dead.value()).isEqualTo("{ this is not json");
        assertThat(headerValue(dead, "kafka_dlt-exception-fqcn")).contains("DeserializationException");
    }

    @Test
    void aFailingSideEffectIsRetriedThenDeadLettered_leavingNoLedgerRow() {
        UUID eventId = UUID.randomUUID();
        UUID ghostUser = UUID.randomUUID();     // no such user → FK violation on the notifications insert
        MessageSent event = new MessageSent(eventId, Instant.now(), UUID.randomUUID(), 1, 1,
                UUID.randomUUID(), "Producer", "@ghost", List.of(ghostUser));
        String key = event.chatroomId().toString();
        kafka.send(messageEvents, key, event);

        ConsumerRecord<String, String> dead = awaitDlt(key, Duration.ofSeconds(60));   // 0.5+1+2+4 s of back-off first
        String diagnostics = describe(dead);
        assertThat(headerValue(dead, "kafka_dlt-exception-fqcn") + headerValue(dead, "kafka_dlt-exception-cause-fqcn"))
                .as(diagnostics).contains("DataIntegrityViolationException");
        long claims = jdbc.sql("select count(*) from processed_events where event_id = :e")
                .param("e", eventId).query(Long.class).single();
        assertThat(claims).isZero();
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private long inboxRows(UUID userId, long messageId) {
        return jdbc.sql("select count(*) from notifications where user_id = :u and payload->>'messageId' = :m")
                .param("u", userId).param("m", String.valueOf(messageId)).query(Long.class).single();
    }

    private KafkaProducer<String, String> rawProducer() {
        Properties p = new Properties();
        p.put(ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaContainer.getBootstrapServers());
        p.put(ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        p.put(ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class.getName());
        return new KafkaProducer<>(p);
    }

    private ConsumerRecord<String, String> awaitDlt(String key, Duration timeout) {
        Properties p = new Properties();
        p.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaContainer.getBootstrapServers());
        p.put(ConsumerConfig.GROUP_ID_CONFIG, "it-dlt-" + UUID.randomUUID());
        p.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        p.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        p.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        StringBuilder seen = new StringBuilder();
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(p)) {
            consumer.subscribe(List.of(messageEvents + "-dlt"));
            long deadline = System.currentTimeMillis() + timeout.toMillis();
            while (System.currentTimeMillis() < deadline) {
                ConsumerRecords<String, String> polled = consumer.poll(Duration.ofSeconds(1));
                for (ConsumerRecord<String, String> r : polled) {
                    if (key.equals(r.key())) return r;
                    seen.append("\n  key=").append(r.key())
                            .append(" exception=").append(headerValue(r, "kafka_dlt-exception-fqcn"))
                            .append(" message=").append(headerValue(r, "kafka_dlt-exception-message"));
                }
            }
        }
        throw new AssertionError("No DLT record with key " + key + " within " + timeout + "; other DLT records seen:" + seen);
    }

    private static String describe(ConsumerRecord<String, String> r) {
        return "DLT record key=" + r.key()
                + " exception=" + headerValue(r, "kafka_dlt-exception-fqcn")
                + " cause=" + headerValue(r, "kafka_dlt-exception-cause-fqcn")
                + " message=" + headerValue(r, "kafka_dlt-exception-message");
    }

    private static String headerValue(ConsumerRecord<?, ?> record, String name) {
        Header h = record.headers().lastHeader(name);
        return h == null ? "" : new String(h.value(), StandardCharsets.UTF_8);
    }
}
