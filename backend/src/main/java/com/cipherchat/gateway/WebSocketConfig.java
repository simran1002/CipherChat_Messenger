package com.cipherchat.gateway;

import java.util.Arrays;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.messaging.simp.config.ChannelRegistration;
import org.springframework.messaging.simp.config.MessageBrokerRegistry;
import org.springframework.web.socket.config.annotation.EnableWebSocketMessageBroker;
import org.springframework.web.socket.config.annotation.StompEndpointRegistry;
import org.springframework.web.socket.config.annotation.WebSocketMessageBrokerConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

/**
 * STOMP over a raw WebSocket at {@code /ws}.
 *
 * <ul>
 *   <li>{@code /app/**} — client → server frames handled by {@link StompController}.</li>
 *   <li>{@code /topic/rooms/{id}}, {@code /topic/dm/{id}}, {@code /topic/presence} — broadcasts.</li>
 *   <li>{@code /user/queue/**} — per-user deliveries (ACKs, DM notifications, mentions).</li>
 * </ul>
 *
 * <p>The simple in-memory broker is deliberate: a full STOMP relay (RabbitMQ,
 * ActiveMQ) would add a fourth stateful system for a job Redis pub/sub already
 * does — see {@link RedisFanout}. No SockJS fallback: modern browsers all
 * speak WebSocket, and a websocket-only client is what lets the load balancer
 * use least-connections instead of sticky sessions.
 */
@Configuration
@EnableWebSocketMessageBroker
public class WebSocketConfig implements WebSocketMessageBrokerConfigurer {

    private final StompAuthInterceptor authInterceptor;
    private final String[] allowedOrigins;

    public WebSocketConfig(StompAuthInterceptor authInterceptor,
                           @Value("${cipherchat.cors.allowed-origins}") String allowedOrigins) {
        this.authInterceptor = authInterceptor;
        this.allowedOrigins = Arrays.stream(allowedOrigins.split(",")).map(String::trim).toArray(String[]::new);
    }

    @Override
    public void registerStompEndpoints(StompEndpointRegistry registry) {
        registry.addEndpoint("/ws").setAllowedOriginPatterns(allowedOrigins);
    }

    @Override
    public void configureMessageBroker(MessageBrokerRegistry registry) {
        registry.enableSimpleBroker("/topic", "/queue")
                .setHeartbeatValue(new long[] {25_000, 25_000})
                .setTaskScheduler(new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler() {{
                    setPoolSize(1);
                    setThreadNamePrefix("ws-heartbeat-");
                    initialize();
                }});
        registry.setApplicationDestinationPrefixes("/app");
        registry.setUserDestinationPrefix("/user");
    }

    @Override
    public void configureClientInboundChannel(ChannelRegistration registration) {
        registration.interceptors(authInterceptor);
    }

    @Override
    public void configureWebSocketTransport(WebSocketTransportRegistration registry) {
        registry.setMessageSizeLimit(64 * 1024);        // an E2EE envelope with init block is < 2 KB
        registry.setSendBufferSizeLimit(512 * 1024);
        registry.setSendTimeLimit(10_000);
    }
}
