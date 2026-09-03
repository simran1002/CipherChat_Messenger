package com.cipherchat.shared.security;

import java.util.UUID;

/**
 * The authenticated principal placed in the security context by the JWT
 * filter (HTTP) and the STOMP channel interceptor (WebSocket). Immutable and
 * minimal on purpose — anything else is a database lookup by {@code id}.
 */
public record AuthenticatedUser(UUID id, String email, String role) {

    public boolean isAdmin() {
        return "ADMIN".equals(role);
    }
}
