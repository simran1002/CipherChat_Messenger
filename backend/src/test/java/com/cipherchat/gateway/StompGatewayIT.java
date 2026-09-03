package com.cipherchat.gateway;

import static org.assertj.core.api.Assertions.assertThat;

import java.lang.reflect.Type;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.messaging.converter.JacksonJsonMessageConverter;
import org.springframework.messaging.simp.stomp.StompFrameHandler;
import org.springframework.messaging.simp.stomp.StompHeaders;
import org.springframework.messaging.simp.stomp.StompSession;
import org.springframework.messaging.simp.stomp.StompSessionHandlerAdapter;
import org.springframework.web.socket.WebSocketHttpHeaders;
import org.springframework.web.socket.client.standard.StandardWebSocketClient;
import org.springframework.web.socket.messaging.WebSocketStompClient;

import com.cipherchat.AbstractIntegrationTest;

/** The real-time contract over a real socket: JWT at CONNECT, ACK on the private queue, broadcast on the room topic. */
class StompGatewayIT extends AbstractIntegrationTest {

    @SuppressWarnings("unchecked")
    private String createRoom(Session owner) {
        ResponseEntity<Map> res = http().post().uri("/api/v1/chatrooms")
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("name", "ws-" + UUID.randomUUID().toString().substring(0, 8), "isPrivate", false))
                .retrieve().toEntity(Map.class);
        return (String) res.getBody().get("id");
    }

    private StompSession connect(Session who) throws InterruptedException, ExecutionException, TimeoutException {
        WebSocketStompClient client = new WebSocketStompClient(new StandardWebSocketClient());
        client.setMessageConverter(new JacksonJsonMessageConverter());
        StompHeaders connectHeaders = new StompHeaders();
        connectHeaders.add(HttpHeaders.AUTHORIZATION, who.bearer());
        return client.connectAsync("ws://localhost:" + port + "/ws", new WebSocketHttpHeaders(), connectHeaders,
                new StompSessionHandlerAdapter() { }).get(10, TimeUnit.SECONDS);
    }

    private static StompFrameHandler collectInto(BlockingQueue<Map<String, Object>> queue) {
        return new StompFrameHandler() {
            @Override
            public Type getPayloadType(StompHeaders headers) {
                return Map.class;
            }

            @Override
            @SuppressWarnings("unchecked")
            public void handleFrame(StompHeaders headers, Object payload) {
                queue.add((Map<String, Object>) payload);
            }
        };
    }

    @Test
    void sendOverStomp_isAcked_andBroadcastToTheRoom() throws Exception {
        Session alice = register("Ws Alice");
        Session bob = register("Ws Bob");
        String room = createRoom(alice);
        http().post().uri("/api/v1/chatrooms/{id}/join", room)
                .header(HttpHeaders.AUTHORIZATION, bob.bearer()).retrieve().toBodilessEntity();

        StompSession a = connect(alice);
        StompSession b = connect(bob);
        BlockingQueue<Map<String, Object>> acks = new LinkedBlockingQueue<>();
        BlockingQueue<Map<String, Object>> bobsRoom = new LinkedBlockingQueue<>();
        a.subscribe("/user/queue/acks", collectInto(acks));
        b.subscribe("/topic/rooms/" + room, collectInto(bobsRoom));
        Thread.sleep(300);   // let the SUBSCRIBE frames register before the SEND

        UUID clientId = UUID.randomUUID();
        a.send("/app/rooms/send", Map.of("chatroomId", room, "message", "hello over stomp", "clientMessageId", clientId.toString()));

        Map<String, Object> ack = acks.poll(10, TimeUnit.SECONDS);
        assertThat(ack).isNotNull();
        assertThat(ack).containsEntry("ok", true).containsEntry("sequenceNumber", 1).containsEntry("clientMessageId", clientId.toString());

        Map<String, Object> frame = bobsRoom.poll(10, TimeUnit.SECONDS);
        assertThat(frame).isNotNull();
        assertThat(frame).containsEntry("event", "newMessage");
        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) frame.get("payload");
        assertThat(payload).containsEntry("message", "hello over stomp").containsEntry("userId", alice.id().toString());

        // Same client id again → duplicate ACK, no second broadcast.
        a.send("/app/rooms/send", Map.of("chatroomId", room, "message", "hello over stomp", "clientMessageId", clientId.toString()));
        Map<String, Object> dup = acks.poll(10, TimeUnit.SECONDS);
        assertThat(dup).isNotNull().containsEntry("duplicate", true);
        assertThat(bobsRoom.poll(2, TimeUnit.SECONDS)).isNull();

        a.disconnect();
        b.disconnect();
    }

    @Test
    void outsiderCannotSubscribeToAPrivateRoom_orToSomeoneElsesDm() throws Exception {
        Session owner = register("Ws Owner");
        Session member = register("Ws Member");
        Session outsider = register("Ws Outsider");
        ResponseEntity<Map> created = http().post().uri("/api/v1/chatrooms")
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("name", "ws-private-" + UUID.randomUUID().toString().substring(0, 8), "isPrivate", true))
                .retrieve().toEntity(Map.class);
        String room = (String) created.getBody().get("id");
        http().post().uri("/api/v1/chatrooms/{id}/invite", room)
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("userId", member.id().toString())).retrieve().toBodilessEntity();
        ResponseEntity<Map> conv = http().post().uri("/api/v1/conversations")
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("targetUserId", member.id().toString())).retrieve().toEntity(Map.class);
        String conversation = (String) conv.getBody().get("id");

        StompSession eve = connect(outsider);
        StompSession legit = connect(member);
        BlockingQueue<Map<String, Object>> evesRoom = new LinkedBlockingQueue<>();
        BlockingQueue<Map<String, Object>> evesDm = new LinkedBlockingQueue<>();
        BlockingQueue<Map<String, Object>> membersRoom = new LinkedBlockingQueue<>();
        eve.subscribe("/topic/rooms/" + room, collectInto(evesRoom));
        eve.subscribe("/topic/dm/" + conversation, collectInto(evesDm));
        legit.subscribe("/topic/rooms/" + room, collectInto(membersRoom));
        Thread.sleep(300);

        http().post().uri("/api/v1/chatrooms/{id}/messages", room)
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("message", "members only")).retrieve().toBodilessEntity();
        http().post().uri("/api/v1/conversations/{id}/messages", conversation)
                .header(HttpHeaders.AUTHORIZATION, owner.bearer())
                .body(Map.of("message", "legacy plaintext dm")).retrieve().toBodilessEntity();

        Map<String, Object> seenByMember = membersRoom.poll(10, TimeUnit.SECONDS);
        assertThat(seenByMember).isNotNull().containsEntry("event", "newMessage");
        // The refused subscriptions never deliver — not even after the legitimate member's frame arrived.
        assertThat(evesRoom.poll(2, TimeUnit.SECONDS)).isNull();
        assertThat(evesDm.poll(1, TimeUnit.SECONDS)).isNull();

        if (eve.isConnected()) eve.disconnect();
        legit.disconnect();
    }

    @Test
    void connectWithoutAValidTokenIsRefused() {
        WebSocketStompClient client = new WebSocketStompClient(new StandardWebSocketClient());
        client.setMessageConverter(new JacksonJsonMessageConverter());
        StompHeaders headers = new StompHeaders();
        headers.add(HttpHeaders.AUTHORIZATION, "Bearer not-a-token");
        var future = client.connectAsync("ws://localhost:" + port + "/ws", new WebSocketHttpHeaders(), headers,
                new StompSessionHandlerAdapter() { });
        org.assertj.core.api.Assertions.assertThatThrownBy(() -> future.get(10, TimeUnit.SECONDS))
                .isInstanceOfAny(ExecutionException.class, TimeoutException.class);
    }
}
