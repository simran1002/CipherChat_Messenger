package com.cipherchat.shared.security;

import java.util.Optional;
import java.util.UUID;

import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;

import com.cipherchat.shared.api.ApiException;

/** Static access to the caller — controllers pass the id down; services never touch the security context. */
public final class CurrentUser {

    private CurrentUser() {
    }

    public static Optional<AuthenticatedUser> find() {
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth != null && auth.getPrincipal() instanceof AuthenticatedUser user) {
            return Optional.of(user);
        }
        return Optional.empty();
    }

    public static AuthenticatedUser require() {
        return find().orElseThrow(() -> ApiException.unauthorized("unauthorized", "Authentication required."));
    }

    public static UUID id() {
        return require().id();
    }
}
