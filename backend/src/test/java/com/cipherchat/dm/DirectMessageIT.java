package com.cipherchat.dm;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;

import com.cipherchat.AbstractIntegrationTest;

/** E2EE transport guarantees the server CAN enforce: participation, structure, dedup, replay. */
class DirectMessageIT extends AbstractIntegrationTest {

    private static Map<String, Object> envelope(String sessionId, long ctr) {
        Map<String, Object> e = new HashMap<>();
        e.put("v", 1);
        e.put("sessionId", sessionId);
        e.put("ctr", ctr);
        e.put("ct", Base64.getEncoder().encodeToString(new byte[256]));
        return e;
    }

    @SuppressWarnings("unchecked")
    private String start(Session a, Session b) {
        ResponseEntity<Map> res = http().post().uri("/api/v1/conversations")
                .header(HttpHeaders.AUTHORIZATION, a.bearer())
                .body(Map.of("targetUserId", b.id().toString())).retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isEqualTo(201);
        return (String) res.getBody().get("id");
    }

    private ResponseEntity<Map> send(Session who, String conv, Map<String, Object> body) {
        return http().post().uri("/api/v1/conversations/{id}/messages", conv)
                .header(HttpHeaders.AUTHORIZATION, who.bearer()).body(body).retrieve().toEntity(Map.class);
    }

    @Test
    void conversationIsSymmetric_andStartIsIdempotent() {
        Session a = register("Anne");
        Session b = register("Bob");
        String fromA = start(a, b);
        String fromB = start(b, a);
        assertThat(fromB).isEqualTo(fromA);
    }

    @Test
    void envelopesAreStoredOpaque_replayedCountersAreRejected_retriesAbsorbed() {
        Session a = register("Sender");
        Session b = register("Recipient");
        String conv = start(a, b);
        String session = UUID.randomUUID().toString();
        UUID clientId = UUID.randomUUID();

        ResponseEntity<Map> first = send(a, conv, Map.of("clientMessageId", clientId.toString(), "envelope", envelope(session, 0)));
        assertThat(first.getStatusCode().value()).isEqualTo(201);
        assertThat(first.getBody()).containsEntry("duplicate", false);
        Map<String, Object> view = (Map<String, Object>) first.getBody().get("message");
        assertThat(view).containsEntry("type", "e2ee/v1").containsKey("envelope");
        assertThat(view.get("message")).isNull();                      // never a plaintext body for E2EE rows

        ResponseEntity<Map> retry = send(a, conv, Map.of("clientMessageId", clientId.toString(), "envelope", envelope(session, 0)));
        assertThat(retry.getStatusCode().value()).isEqualTo(201);
        assertThat(retry.getBody()).containsEntry("duplicate", true);

        // Same (session, ctr) under a NEW client id → not a retry, a replay.
        ResponseEntity<Map> replay = send(a, conv, Map.of("clientMessageId", UUID.randomUUID().toString(), "envelope", envelope(session, 0)));
        assertThat(replay.getStatusCode().value()).isEqualTo(409);
        assertThat(replay.getBody()).containsEntry("code", "replayed_counter");

        assertThat(send(a, conv, Map.of("envelope", envelope(session, 1))).getStatusCode().value()).isEqualTo(201);

        ResponseEntity<Map> history = http().get().uri("/api/v1/conversations/{id}/messages", conv)
                .header(HttpHeaders.AUTHORIZATION, b.bearer()).retrieve().toEntity(Map.class);
        List<Map<String, Object>> messages = (List<Map<String, Object>>) history.getBody().get("messages");
        assertThat(messages).hasSize(2);
        assertThat(messages).allSatisfy(m -> assertThat(m.get("envelope")).isNotNull());
    }

    @Test
    void nonParticipantsGet403_evenWithAValidToken() {
        Session a = register("Pa");
        Session b = register("Pb");
        Session eve = register("Eve");
        String conv = start(a, b);

        ResponseEntity<Map> read = http().get().uri("/api/v1/conversations/{id}/messages", conv)
                .header(HttpHeaders.AUTHORIZATION, eve.bearer()).retrieve().toEntity(Map.class);
        assertThat(read.getStatusCode().value()).isEqualTo(403);
        assertThat(send(eve, conv, Map.of("envelope", envelope("s", 0))).getStatusCode().value()).isEqualTo(403);
    }

    @Test
    void malformedEnvelopesAndMixedBodiesAre400() {
        Session a = register("Ma");
        Session b = register("Mb");
        String conv = start(a, b);

        Map<String, Object> bad = envelope("s", 0);
        bad.put("v", 9);
        assertThat(send(a, conv, Map.of("envelope", bad)).getStatusCode().value()).isEqualTo(400);

        ResponseEntity<Map> both = send(a, conv, Map.of("message", "plain", "envelope", envelope("s", 0)));
        assertThat(both.getStatusCode().value()).isEqualTo(400);
        assertThat(both.getBody()).containsEntry("code", "invalid_message");

        assertThat(send(a, conv, Map.of()).getStatusCode().value()).isEqualTo(400);
    }

    @Test
    void sidebarPreviewIsContentFreeForEncryptedConversations() {
        Session a = register("Sa");
        Session b = register("Sb");
        String conv = start(a, b);
        send(a, conv, Map.of("envelope", envelope(UUID.randomUUID().toString(), 0)));

        ResponseEntity<List> list = http().get().uri("/api/v1/conversations")
                .header(HttpHeaders.AUTHORIZATION, b.bearer()).retrieve().toEntity(List.class);
        Map<String, Object> row = ((List<Map<String, Object>>) list.getBody()).stream()
                .filter(c -> conv.equals(c.get("id"))).findFirst().orElseThrow();
        Map<String, Object> preview = (Map<String, Object>) row.get("lastMessage");
        assertThat(preview).containsEntry("encrypted", true);
        assertThat((String) preview.get("message")).doesNotContain("AAAA");   // no ciphertext, no plaintext
    }
}
