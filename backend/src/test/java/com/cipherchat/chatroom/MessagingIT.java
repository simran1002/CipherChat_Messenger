package com.cipherchat.chatroom;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;

import com.cipherchat.AbstractIntegrationTest;

/** The exactly-once contract over the real stack: Redis dedup + sequence, Postgres unique backstops. */
class MessagingIT extends AbstractIntegrationTest {

    @SuppressWarnings("unchecked")
    private String createRoom(Session owner, String name, boolean isPrivate) {
        ResponseEntity<Map> res = http().post().uri("/api/v1/chatrooms")
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("name", name, "isPrivate", isPrivate)).retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isEqualTo(201);
        return (String) res.getBody().get("id");
    }

    private ResponseEntity<Map> send(Session who, String roomId, String text, UUID clientId) {
        Map<String, Object> body = clientId == null
                ? Map.of("message", text)
                : Map.of("message", text, "clientMessageId", clientId.toString());
        return http().post().uri("/api/v1/chatrooms/{id}/messages", roomId)
                .header(HttpHeaders.AUTHORIZATION, who.bearer()).body(body).retrieve().toEntity(Map.class);
    }

    @Test
    void retriesWithTheSameClientIdAreAbsorbed_andSequencesAreGapless() {
        Session alice = register("Alice");
        String room = createRoom(alice, "seq-" + UUID.randomUUID().toString().substring(0, 8), false);
        UUID clientId = UUID.randomUUID();

        ResponseEntity<Map> first = send(alice, room, "hello", clientId);
        assertThat(first.getStatusCode().value()).isEqualTo(201);
        assertThat(first.getBody()).containsEntry("duplicate", false).containsEntry("sequenceNumber", 1);
        String messageId = (String) first.getBody().get("messageId");

        ResponseEntity<Map> retry = send(alice, room, "hello", clientId);
        assertThat(retry.getStatusCode().value()).isEqualTo(201);
        assertThat(retry.getBody()).containsEntry("duplicate", true).containsEntry("messageId", messageId)
                .containsEntry("sequenceNumber", 1);

        ResponseEntity<Map> second = send(alice, room, "world", UUID.randomUUID());
        assertThat(second.getBody()).containsEntry("sequenceNumber", 2);

        ResponseEntity<Map> history = http().get().uri("/api/v1/chatrooms/{id}/messages", room)
                .header(HttpHeaders.AUTHORIZATION, alice.bearer()).retrieve().toEntity(Map.class);
        List<Map<String, Object>> messages = (List<Map<String, Object>>) history.getBody().get("messages");
        assertThat(messages).extracting(m -> m.get("message")).containsExactly("hello", "world");
        assertThat(messages).extracting(m -> m.get("sequenceNumber")).containsExactly(1, 2);
    }

    @Test
    void privateRoomsAreInvisibleToNonMembers_publicRoomsAreJoinable() {
        Session owner = register("Owner");
        Session outsider = register("Outsider");
        String secret = createRoom(owner, "secret-" + UUID.randomUUID().toString().substring(0, 8), true);
        String open = createRoom(owner, "open-" + UUID.randomUUID().toString().substring(0, 8), false);

        ResponseEntity<Map> denied = http().get().uri("/api/v1/chatrooms/{id}/messages", secret)
                .header(HttpHeaders.AUTHORIZATION, outsider.bearer()).retrieve().toEntity(Map.class);
        assertThat(denied.getStatusCode().value()).isEqualTo(403);

        ResponseEntity<Map> sendDenied = send(outsider, secret, "let me in", null);
        assertThat(sendDenied.getStatusCode().value()).isEqualTo(403);

        ResponseEntity<Map> join = http().post().uri("/api/v1/chatrooms/{id}/join", open)
                .header(HttpHeaders.AUTHORIZATION, outsider.bearer()).retrieve().toEntity(Map.class);
        assertThat(join.getStatusCode().value()).isEqualTo(200);
        assertThat(send(outsider, open, "hi all", null).getStatusCode().value()).isEqualTo(201);
    }

    @Test
    void unreadCountFollowsTheReadWatermark() {
        Session owner = register("Reader");
        Session member = register("Member");
        String room = createRoom(owner, "unread-" + UUID.randomUUID().toString().substring(0, 8), false);
        http().post().uri("/api/v1/chatrooms/{id}/join", room)
                .header(HttpHeaders.AUTHORIZATION, member.bearer()).retrieve().toBodilessEntity();
        send(owner, room, "one", null);
        send(owner, room, "two", null);

        assertThat(unread(member, room)).isEqualTo(2);
        http().post().uri("/api/v1/chatrooms/{id}/read", room)
                .header(HttpHeaders.AUTHORIZATION, member.bearer()).retrieve().toBodilessEntity();
        assertThat(unread(member, room)).isZero();
        send(owner, room, "three", null);
        assertThat(unread(member, room)).isEqualTo(1);
    }

    @SuppressWarnings("unchecked")
    private long unread(Session who, String roomId) {
        ResponseEntity<List> rooms = http().get().uri("/api/v1/chatrooms")
                .header(HttpHeaders.AUTHORIZATION, who.bearer()).retrieve().toEntity(List.class);
        return ((List<Map<String, Object>>) rooms.getBody()).stream()
                .filter(r -> roomId.equals(r.get("id")))
                .map(r -> ((Number) r.get("unreadCount")).longValue()).findFirst().orElseThrow();
    }

    @Test
    void onlyTheAuthorCanEditOrDelete() {
        Session author = register("Author");
        Session other = register("Other");
        String room = createRoom(author, "own-" + UUID.randomUUID().toString().substring(0, 8), false);
        http().post().uri("/api/v1/chatrooms/{id}/join", room)
                .header(HttpHeaders.AUTHORIZATION, other.bearer()).retrieve().toBodilessEntity();
        String messageId = (String) send(author, room, "mine", null).getBody().get("messageId");

        ResponseEntity<Map> denied = http().put().uri("/api/v1/chatrooms/messages/{id}", messageId)
                .header(HttpHeaders.AUTHORIZATION, other.bearer()).body(Map.of("message", "hijacked"))
                .retrieve().toEntity(Map.class);
        assertThat(denied.getStatusCode().value()).isEqualTo(403);

        ResponseEntity<Map> ok = http().put().uri("/api/v1/chatrooms/messages/{id}", messageId)
                .header(HttpHeaders.AUTHORIZATION, author.bearer()).body(Map.of("message", "edited"))
                .retrieve().toEntity(Map.class);
        assertThat(ok.getStatusCode().value()).isEqualTo(200);
        assertThat(ok.getBody()).containsEntry("message", "edited").containsEntry("edited", true);
    }
}
