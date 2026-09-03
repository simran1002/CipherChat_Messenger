package com.cipherchat.analytics;

import org.springframework.kafka.annotation.KafkaHandler;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

import com.cipherchat.shared.events.MessagingEvents.DirectMessageSent;
import com.cipherchat.shared.events.MessagingEvents.MessageDelivered;
import com.cipherchat.shared.events.MessagingEvents.MessageRead;
import com.cipherchat.shared.events.MessagingEvents.MessageSent;
import com.cipherchat.shared.events.MessagingEvents.UserOffline;
import com.cipherchat.shared.events.MessagingEvents.UserOnline;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;

/**
 * Consumer group {@code analytics}. Deliberately NOT ledger-backed: a counter
 * is a statistic, and paying a database write per message to make a
 * Prometheus counter exactly-once is the wrong trade. Redelivery skew is
 * bounded by the retry policy and visible in {@code kafka_consumer_*} metrics.
 */
@Component
@KafkaListener(id = "analytics", groupId = "analytics",
        topics = {"${cipherchat.kafka.topics.message-events}", "${cipherchat.kafka.topics.presence-events}"})
public class AnalyticsConsumer {

    private final Counter roomMessages;
    private final Counter dmEncrypted;
    private final Counter dmPlaintext;
    private final Counter delivered;
    private final Counter read;
    private final Counter online;
    private final Counter offline;

    public AnalyticsConsumer(MeterRegistry registry) {
        roomMessages = Counter.builder("cipherchat.messages").tag("kind", "room").tag("encrypted", "false")
                .description("Messages persisted").register(registry);
        dmEncrypted = Counter.builder("cipherchat.messages").tag("kind", "dm").tag("encrypted", "true").register(registry);
        dmPlaintext = Counter.builder("cipherchat.messages").tag("kind", "dm").tag("encrypted", "false").register(registry);
        delivered = Counter.builder("cipherchat.receipts").tag("type", "delivered").register(registry);
        read = Counter.builder("cipherchat.receipts").tag("type", "read").register(registry);
        online = Counter.builder("cipherchat.presence").tag("event", "online").register(registry);
        offline = Counter.builder("cipherchat.presence").tag("event", "offline").register(registry);
    }

    @KafkaHandler public void on(MessageSent e) { roomMessages.increment(); }
    @KafkaHandler public void on(DirectMessageSent e) { (e.encrypted() ? dmEncrypted : dmPlaintext).increment(); }
    @KafkaHandler public void on(MessageDelivered e) { delivered.increment(); }
    @KafkaHandler public void on(MessageRead e) { read.increment(); }
    @KafkaHandler public void on(UserOnline e) { online.increment(); }
    @KafkaHandler public void on(UserOffline e) { offline.increment(); }

    @KafkaHandler(isDefault = true)
    public void ignore(Object other) {
    }
}
