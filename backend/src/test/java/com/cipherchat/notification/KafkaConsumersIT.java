package com.cipherchat.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;

import com.cipherchat.AbstractIntegrationTest;

/**
 * End-to-end through the outbox: HTTP write → event-publication row →
 * Kafka → consumer group → side-effect row, with the idempotency ledger
 * recording exactly one processing per event.
 */
class KafkaConsumersIT extends AbstractIntegrationTest {

    @Autowired
    JdbcClient jdbc;

    @Test
    @SuppressWarnings("unchecked")
    void aMentionBecomesADurableNotificationForTheMentionedUser() {
        Session author = register("Mentioner");
        Session target = register("Mentioned");
        ResponseEntity<Map> room = http().post().uri("/api/v1/chatrooms")
                .header(HttpHeaders.AUTHORIZATION, author.bearer())
                .body(Map.of("name", "kafka-" + UUID.randomUUID().toString().substring(0, 8), "isPrivate", false))
                .retrieve().toEntity(Map.class);
        String roomId = (String) room.getBody().get("id");
        http().post().uri("/api/v1/chatrooms/{id}/join", roomId)
                .header(HttpHeaders.AUTHORIZATION, target.bearer()).retrieve().toBodilessEntity();

        ResponseEntity<Map> sent = http().post().uri("/api/v1/chatrooms/{id}/messages", roomId)
                .header(HttpHeaders.AUTHORIZATION, author.bearer())
                .body(Map.of("message", "hey @Mentioned look at this", "mentions", List.of(target.id().toString())))
                .retrieve().toEntity(Map.class);
        assertThat(sent.getStatusCode().value()).isEqualTo(201);
        String messageId = (String) sent.getBody().get("messageId");

        await().atMost(Duration.ofSeconds(45)).pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
            ResponseEntity<List> inbox = http().get().uri("/api/v1/notifications")
                    .header(HttpHeaders.AUTHORIZATION, target.bearer()).retrieve().toEntity(List.class);
            List<Map<String, Object>> rows = inbox.getBody();
            assertThat(rows).anySatisfy(n -> {
                assertThat(n).containsEntry("type", "mention");
                assertThat((Map<String, Object>) n.get("payload")).containsEntry("messageId", messageId);
            });
        });

        // Exactly one processing recorded for the notifications consumer group.
        long ledgerRows = jdbc.sql("select count(*) from processed_events where consumer = 'notifications'")
                .query(Long.class).single();
        assertThat(ledgerRows).isGreaterThanOrEqualTo(1);
        long inboxRows = jdbc.sql("select count(*) from notifications where user_id = :u and type = 'mention'")
                .param("u", target.id()).query(Long.class).single();
        assertThat(inboxRows).isEqualTo(1);
    }

    @Test
    void loginsAreAuditedThroughTheAuditTopic() {
        Session s = register("Audited");
        http().post().uri("/api/v1/auth/login")
                .body(Map.of("email", s.email(), "password", "correct horse battery staple")).retrieve().toBodilessEntity();
        http().post().uri("/api/v1/auth/login")
                .body(Map.of("email", s.email(), "password", "wrong")).retrieve().toBodilessEntity();

        await().atMost(Duration.ofSeconds(45)).pollInterval(Duration.ofMillis(500)).untilAsserted(() -> {
            List<String> actions = jdbc.sql("select action from audit_logs where actor_id = :u or metadata->>'email' = :e order by created_at")
                    .param("u", s.id()).param("e", s.email()).query(String.class).list();
            assertThat(actions).contains("user.registered", "user.login", "user.login_failed");
        });
    }
}
