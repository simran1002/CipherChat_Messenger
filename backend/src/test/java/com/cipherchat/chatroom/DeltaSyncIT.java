package com.cipherchat.chatroom;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

import com.cipherchat.AbstractIntegrationTest;

import tools.jackson.databind.JsonNode;
import tools.jackson.dataformat.cbor.CBORMapper;

/** Sequence-based delta sync against the real stack: forward paging, denied rooms, and JSON/CBOR parity. */
class DeltaSyncIT extends AbstractIntegrationTest {

    @SuppressWarnings("unchecked")
    private String createRoom(Session owner, boolean isPrivate) {
        ResponseEntity<Map> res = http().post().uri("/api/v1/chatrooms")
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("name", "sync-" + UUID.randomUUID().toString().substring(0, 8), "isPrivate", isPrivate))
                .retrieve().toEntity(Map.class);
        return (String) res.getBody().get("id");
    }

    private void send(Session who, String roomId, String text) {
        http().post().uri("/api/v1/chatrooms/{id}/messages", roomId)
                .header(HttpHeaders.AUTHORIZATION, who.bearer())
                .body(Map.of("message", text, "clientMessageId", UUID.randomUUID().toString()))
                .retrieve().toBodilessEntity();
    }

    @Test
    @SuppressWarnings("unchecked")
    void returnsOnlyWhatCameAfterTheCursor_pagesForward_andReportsDeniedRooms() {
        Session alice = register("Alice");
        Session mallory = register("Mallory");
        String room = createRoom(alice, false);
        String secret = createRoom(mallory, true);
        for (int i = 1; i <= 5; i++) send(alice, room, "m" + i);

        ResponseEntity<Map> res = http().post().uri("/api/v1/sync/rooms")
                .header(HttpHeaders.AUTHORIZATION, alice.bearer())
                .body(Map.of("rooms", Map.of(room, 2, secret, 0), "maxPerRoom", 2))
                .retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isEqualTo(200);

        List<Map<String, Object>> rooms = (List<Map<String, Object>>) res.getBody().get("rooms");
        Map<String, Object> mine = rooms.stream().filter(r -> room.equals(r.get("room"))).findFirst().orElseThrow();
        List<Map<String, Object>> msgs = (List<Map<String, Object>>) mine.get("msgs");
        assertThat(msgs).extracting(m -> m.get("b")).containsExactly("m3", "m4");      // after seq 2, capped at 2
        assertThat(msgs).extracting(m -> m.get("s")).containsExactly(3, 4);
        assertThat(mine).containsEntry("m", true).containsEntry("w", 5).containsEntry("d", false);

        Map<String, Object> theirs = rooms.stream().filter(r -> secret.equals(r.get("room"))).findFirst().orElseThrow();
        assertThat(theirs).containsEntry("d", true);
        assertThat((List<?>) theirs.get("msgs")).isEmpty();

        // Second page from the new cursor drains the rest and clears the "more" flag.
        ResponseEntity<Map> next = http().post().uri("/api/v1/sync/rooms")
                .header(HttpHeaders.AUTHORIZATION, alice.bearer())
                .body(Map.of("rooms", Map.of(room, 4), "maxPerRoom", 2)).retrieve().toEntity(Map.class);
        Map<String, Object> tail = ((List<Map<String, Object>>) next.getBody().get("rooms")).getFirst();
        assertThat((List<Map<String, Object>>) tail.get("msgs")).extracting(m -> m.get("b")).containsExactly("m5");
        assertThat(tail).containsEntry("m", false).containsEntry("w", 5);
    }

    @Test
    void cborCarriesTheSameDataInFewerBytes() throws Exception {
        Session alice = register("Alice");
        String room = createRoom(alice, false);
        // 15 sends stays inside the per-user message burst (20), so every send is accepted.
        for (int i = 1; i <= 15; i++) send(alice, room, "status update number " + i + " from the newsroom desk");

        Map<String, Object> request = Map.of("rooms", Map.of(room, 0));
        byte[] json = http().post().uri("/api/v1/sync/rooms")
                .header(HttpHeaders.AUTHORIZATION, alice.bearer()).accept(MediaType.APPLICATION_JSON)
                .body(request).retrieve().body(byte[].class);
        ResponseEntity<byte[]> cbor = http().post().uri("/api/v1/sync/rooms")
                .header(HttpHeaders.AUTHORIZATION, alice.bearer()).accept(MediaType.APPLICATION_CBOR)
                .body(request).retrieve().toEntity(byte[].class);

        assertThat(cbor.getHeaders().getContentType()).isNotNull();
        assertThat(cbor.getHeaders().getContentType().isCompatibleWith(MediaType.APPLICATION_CBOR)).isTrue();

        JsonNode fromCbor = new CBORMapper().readTree(cbor.getBody());
        JsonNode fromJson = new tools.jackson.databind.ObjectMapper().readTree(json);
        assertThat(fromCbor).isEqualTo(fromJson);
        assertThat(fromCbor.get("rooms").get(0).get("msgs")).hasSize(15);
        assertThat(cbor.getBody().length).isLessThan(json.length);
        System.out.printf("delta sync, 15 messages: json=%d bytes, cbor=%d bytes (%.0f%%)%n",
                json.length, cbor.getBody().length, 100.0 * cbor.getBody().length / json.length);
    }
}
