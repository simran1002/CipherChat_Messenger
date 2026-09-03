package com.cipherchat.auth;

import java.time.Duration;

import org.springframework.boot.context.properties.ConfigurationProperties;

/** Bound from {@code cipherchat.security.*}; validated at startup by {@link SecurityConfig}. */
@ConfigurationProperties(prefix = "cipherchat.security")
public record SecurityProperties(
        String jwtSecret,
        Duration accessTokenTtl,
        Duration refreshTokenTtl,
        Duration twoFactorPendingTtl,
        String sealSecret,
        boolean cookieSecure) {
}
