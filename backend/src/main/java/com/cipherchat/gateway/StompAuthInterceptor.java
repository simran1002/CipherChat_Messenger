package com.cipherchat.gateway;

import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;

import com.cipherchat.auth.JwtService;
import com.cipherchat.chatroom.ChatroomService;
import com.cipherchat.dm.DmService;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.security.AuthenticatedUser;

/**
 * Authentication and subscription authorisation for the STOMP channel.
 *
 * <ul>
 *   <li><b>CONNECT</b> — the {@code Authorization: Bearer <access token>} frame
 *       header is verified once; the token never appears in the URL (which
 *       proxies and access logs record). The principal's name is the user id,
 *       which is what routes {@code /user/queue/…} deliveries.</li>
 *   <li><b>SUBSCRIBE</b> — {@code /topic/rooms/{id}} requires room access,
 *       {@code /topic/dm/{id}} requires conversation participation,
 *       {@code /topic/presence} and the caller's own {@code /user/**} queues are
 *       open to any authenticated session; every other destination is refused.
 *       Without this check any signed-in user could read every room's frames
 *       and every DM's ciphertext and metadata.</li>
 *   <li>Every other frame must carry the principal set at CONNECT.</li>
 * </ul>
 */
@Component
public class StompAuthInterceptor implements ChannelInterceptor {

    private static final Logger log = LoggerFactory.getLogger(StompAuthInterceptor.class);
    static final String ROOM_TOPIC = "/topic/rooms/";
    static final String DM_TOPIC = "/topic/dm/";
    static final String PRESENCE_TOPIC = "/topic/presence";

    private final JwtService jwt;
    private final ChatroomService rooms;
    private final DmService dms;

    public StompAuthInterceptor(JwtService jwt, ChatroomService rooms, DmService dms) {
        this.jwt = jwt;
        this.rooms = rooms;
        this.dms = dms;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null || accessor.getCommand() == null) return message;

        switch (accessor.getCommand()) {
            case CONNECT -> authenticate(accessor);
            case DISCONNECT -> { }
            case SUBSCRIBE -> authoriseSubscription(accessor, requirePrincipal(accessor));
            default -> requirePrincipal(accessor);
        }
        return message;
    }

    private void authenticate(StompHeaderAccessor accessor) {
        String header = accessor.getFirstNativeHeader("Authorization");
        AuthenticatedUser user = header != null && header.startsWith("Bearer ")
                ? jwt.parseAccessToken(header.substring(7).trim()).orElse(null)
                : null;
        if (user == null) {
            throw new BadCredentialsException("Invalid or missing token");
        }
        var auth = new UsernamePasswordAuthenticationToken(user, null, List.of(new SimpleGrantedAuthority("ROLE_" + user.role())));
        auth.setDetails(user);
        accessor.setUser(new StompPrincipal(user));
    }

    private static StompPrincipal requirePrincipal(StompHeaderAccessor accessor) {
        if (accessor.getUser() instanceof StompPrincipal p) return p;
        throw new BadCredentialsException("Not authenticated");
    }

    private void authoriseSubscription(StompHeaderAccessor accessor, StompPrincipal principal) {
        String destination = accessor.getDestination();
        UUID userId = principal.user().id();
        if (destination == null) throw new AccessDeniedException("Missing destination");
        try {
            if (destination.startsWith(ROOM_TOPIC)) {
                rooms.assertAccess(UUID.fromString(destination.substring(ROOM_TOPIC.length())), userId);
            } else if (destination.startsWith(DM_TOPIC)) {
                dms.requireParticipant(UUID.fromString(destination.substring(DM_TOPIC.length())), userId);
            } else if (!PRESENCE_TOPIC.equals(destination) && !destination.startsWith("/user/")) {
                throw new AccessDeniedException("Unknown destination " + destination);
            }
        } catch (ApiException | IllegalArgumentException denied) {
            log.warn("SUBSCRIBE refused userId={} destination={} reason={}", userId, destination, denied.getMessage());
            throw new AccessDeniedException("Not allowed to subscribe to " + destination);
        }
    }

    /** Principal whose {@code getName()} is the user id — the key for user destinations. */
    public record StompPrincipal(AuthenticatedUser user) implements java.security.Principal {
        @Override
        public String getName() {
            return user.id().toString();
        }
    }
}
