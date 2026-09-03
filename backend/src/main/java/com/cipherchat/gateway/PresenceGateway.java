package com.cipherchat.gateway;

import java.util.Map;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.context.event.EventListener;
import org.springframework.messaging.handler.annotation.MessageMapping;
import org.springframework.messaging.handler.annotation.Payload;
import org.springframework.messaging.simp.SimpMessagingTemplate;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.stereotype.Controller;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.socket.messaging.SessionConnectedEvent;
import org.springframework.web.socket.messaging.SessionDisconnectEvent;

import com.cipherchat.gateway.StompAuthInterceptor.StompPrincipal;
import com.cipherchat.gateway.WsPayloads.RoomRef;
import com.cipherchat.presence.PresenceService;
import com.cipherchat.shared.infra.AppMetrics;
import com.cipherchat.user.PresenceStatus;
import com.cipherchat.user.UserService;

/**
 * Socket lifecycle → presence, plus the presence/typing frames. The roster
 * broadcast is throttled ({@link RosterBroadcaster}): a burst of 500 connects
 * costs one leading and one trailing broadcast, not 500 — the first thing the
 * 10k-connection benchmark broke in the previous implementation.
 */
@Controller
@Validated
public class PresenceGateway {

    public record PresenceUpdate(PresenceStatus presenceStatus, String presenceNote) {
    }

    private final PresenceService presence;
    private final UserService users;
    private final RedisFanout fanout;
    private final SimpMessagingTemplate simp;
    private final RosterBroadcaster roster;
    private final AppMetrics metrics;

    public PresenceGateway(PresenceService presence, UserService users, RedisFanout fanout,
                           SimpMessagingTemplate simp, RosterBroadcaster roster, AppMetrics metrics) {
        this.presence = presence;
        this.users = users;
        this.fanout = fanout;
        this.simp = simp;
        this.roster = roster;
        this.metrics = metrics;
    }

    @EventListener
    public void onConnected(SessionConnectedEvent event) {
        userOf(event.getMessage().getHeaders()).ifPresent(userId -> {
            metrics.sessionOpened();
            presence.connected(userId);
            roster.request();
            // A page that mounts after CONNECT missed the broadcast — hand this session the roster directly
            simp.convertAndSendToUser(userId.toString(), "/queue/events",
                    new RedisFanout.Frame("onlineUsers", presence.roster()));
        });
    }

    @EventListener
    public void onDisconnected(SessionDisconnectEvent event) {
        userOf(event.getMessage().getHeaders()).ifPresent(userId -> {
            metrics.sessionClosed();
            presence.clearTyping(userId);
            presence.disconnected(userId);
            roster.request();
        });
    }

    @MessageMapping("/presence/heartbeat")
    public void heartbeat(StompPrincipal principal) {
        if (presence.heartbeat(principal.user().id())) {
            roster.request();       // self-healed after a TTL expiry → roster changed
        }
        simp.convertAndSendToUser(principal.getName(), "/queue/events",
                new RedisFanout.Frame("heartbeatAck", Map.of("ts", System.currentTimeMillis())));
    }

    @MessageMapping("/presence/update")
    public void update(@Payload PresenceUpdate frame, StompPrincipal principal) {
        presence.updateStatus(principal.user().id(), frame.presenceStatus(), frame.presenceNote());
        roster.request();
    }

    @MessageMapping("/rooms/typing")
    public void typing(@Valid @Payload RoomRef frame, StompPrincipal principal) {
        UUID userId = principal.user().id();
        presence.typingStarted(frame.chatroomId(), userId);
        String name = users.find(userId).map(u -> u.name()).orElse("");
        fanout.toRoom(frame.chatroomId(), "userTyping",
                Map.of("userId", userId.toString(), "name", name, "chatroomId", frame.chatroomId().toString()));
    }

    @MessageMapping("/rooms/stopTyping")
    public void stopTyping(@Valid @Payload RoomRef frame, StompPrincipal principal) {
        presence.typingStopped(frame.chatroomId(), principal.user().id());
        fanout.toRoom(frame.chatroomId(), "userStopTyping",
                Map.of("userId", principal.getName(), "chatroomId", frame.chatroomId().toString()));
    }

    @EventListener
    public void onTypingExpired(PresenceService.TypingExpired e) {
        fanout.toRoom(e.chatroomId(), "userStopTyping",
                Map.of("userId", e.userId().toString(), "chatroomId", e.chatroomId().toString()));
    }

    private static java.util.Optional<UUID> userOf(org.springframework.messaging.MessageHeaders headers) {
        java.security.Principal p = StompHeaderAccessor.wrap(
                org.springframework.messaging.support.MessageBuilder.withPayload(new byte[0]).copyHeaders(headers).build()).getUser();
        return p instanceof StompPrincipal sp ? java.util.Optional.of(sp.user().id()) : java.util.Optional.empty();
    }
}
