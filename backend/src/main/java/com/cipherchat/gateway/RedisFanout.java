package com.cipherchat.gateway;

import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.listener.PatternTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.stereotype.Component;

import tools.jackson.databind.ObjectMapper;

/**
 * Cross-instance WebSocket fan-out over Redis pub/sub.
 *
 * <p>Spring's simple STOMP broker only knows the sessions on <em>this</em>
 * JVM. Every broadcast is therefore published to a Redis channel and every
 * instance — including the publisher — subscribes to {@code ws:*} and
 * forwards to its own local sessions. Result: N replicas behave as one
 * broker, with no sticky-session requirement for delivery.
 *
 * <p>Why pub/sub here and Kafka for everything else: real-time fan-out wants
 * the lowest latency and tolerates loss (a client that misses a frame
 * re-syncs from history on reconnect), whereas notifications, analytics and
 * audit want durability and replay. Different guarantees, different tools —
 * documented in KAFKA_DESIGN.md.
 */
@Component
public class RedisFanout implements MessageListener {

    private static final Logger log = LoggerFactory.getLogger(RedisFanout.class);
    private static final String ROOM = "ws:room:";
    private static final String DM = "ws:dm:";
    private static final String USER = "ws:user:";
    private static final String ALL = "ws:all";

    public record Frame(String event, Object payload) {
    }

    private final StringRedisTemplate redis;
    private final SimpMessagingTemplate simp;
    private final ObjectMapper json;

    public RedisFanout(StringRedisTemplate redis, SimpMessagingTemplate simp, ObjectMapper json) {
        this.redis = redis;
        this.simp = simp;
        this.json = json;
    }

    public void toRoom(UUID roomId, String event, Object payload) {
        publish(ROOM + roomId, event, payload);
    }

    public void toConversation(UUID conversationId, String event, Object payload) {
        publish(DM + conversationId, event, payload);
    }

    public void toUser(UUID userId, String event, Object payload) {
        publish(USER + userId, event, payload);
    }

    public void toAll(String event, Object payload) {
        publish(ALL, event, payload);
    }

    private void publish(String channel, String event, Object payload) {
        try {
            redis.convertAndSend(channel, json.writeValueAsString(new Frame(event, payload)));
        } catch (RuntimeException e) {
            // Real-time fan-out is best-effort by design; the durable path is Kafka.
            log.warn("Fan-out publish failed channel={} event={} cause={}", channel, event, e.getMessage());
        }
    }

    /** Redis → local STOMP broker. Runs on the listener container's thread. */
    @Override
    public void onMessage(Message message, byte[] pattern) {
        String channel = new String(message.getChannel(), StandardCharsets.UTF_8);
        try {
            // Typed as Object on purpose: a Map payload would otherwise select the (payload, headers) overload.
            Object frame = json.readValue(message.getBody(), Map.class);
            if (channel.startsWith(ROOM)) {
                simp.convertAndSend("/topic/rooms/" + channel.substring(ROOM.length()), frame);
            } else if (channel.startsWith(DM)) {
                simp.convertAndSend("/topic/dm/" + channel.substring(DM.length()), frame);
            } else if (channel.startsWith(USER)) {
                simp.convertAndSendToUser(channel.substring(USER.length()), "/queue/events", frame);
            } else if (ALL.equals(channel)) {
                simp.convertAndSend("/topic/presence", frame);
            }
        } catch (RuntimeException e) {
            log.warn("Dropped malformed fan-out frame channel={} cause={}", channel, e.getMessage());
        }
    }

    @Configuration
    static class ListenerConfig {
        @Bean
        RedisMessageListenerContainer wsListenerContainer(RedisConnectionFactory factory, RedisFanout fanout) {
            RedisMessageListenerContainer container = new RedisMessageListenerContainer();
            container.setConnectionFactory(factory);
            container.addMessageListener(fanout, new PatternTopic("ws:*"));
            return container;
        }
    }
}
