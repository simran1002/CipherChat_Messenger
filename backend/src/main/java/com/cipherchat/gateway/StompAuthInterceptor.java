package com.cipherchat.gateway;

import java.util.List;

import org.springframework.messaging.Message;
import org.springframework.messaging.MessageChannel;
import org.springframework.messaging.simp.stomp.StompCommand;
import org.springframework.messaging.simp.stomp.StompHeaderAccessor;
import org.springframework.messaging.support.ChannelInterceptor;
import org.springframework.messaging.support.MessageHeaderAccessor;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;

import com.cipherchat.auth.JwtService;
import com.cipherchat.shared.security.AuthenticatedUser;

/**
 * Authenticates the socket once, at STOMP CONNECT, from the
 * {@code Authorization: Bearer <access token>} frame header — the token never
 * appears in the URL (which proxies and access logs record). The resulting
 * principal's name is the user id, which is what routes {@code /user/queue/…}
 * deliveries. Every later frame is tied to that principal; a frame without
 * one is dropped.
 */
@Component
public class StompAuthInterceptor implements ChannelInterceptor {

    private final JwtService jwt;

    public StompAuthInterceptor(JwtService jwt) {
        this.jwt = jwt;
    }

    @Override
    public Message<?> preSend(Message<?> message, MessageChannel channel) {
        StompHeaderAccessor accessor = MessageHeaderAccessor.getAccessor(message, StompHeaderAccessor.class);
        if (accessor == null) return message;

        if (StompCommand.CONNECT.equals(accessor.getCommand())) {
            String header = accessor.getFirstNativeHeader("Authorization");
            AuthenticatedUser user = header != null && header.startsWith("Bearer ")
                    ? jwt.parseAccessToken(header.substring(7).trim()).orElse(null)
                    : null;
            if (user == null) {
                throw new org.springframework.security.authentication.BadCredentialsException("Invalid or missing token");
            }
            var auth = new UsernamePasswordAuthenticationToken(user, null, List.of(new SimpleGrantedAuthority("ROLE_" + user.role())));
            auth.setDetails(user);
            accessor.setUser(new StompPrincipal(user));
        } else if (accessor.getCommand() != null && accessor.getUser() == null
                && accessor.getCommand() != StompCommand.DISCONNECT) {
            throw new org.springframework.security.authentication.BadCredentialsException("Not authenticated");
        }
        return message;
    }

    /** Principal whose {@code getName()} is the user id — the key for user destinations. */
    public record StompPrincipal(AuthenticatedUser user) implements java.security.Principal {
        @Override
        public String getName() {
            return user.id().toString();
        }
    }
}
