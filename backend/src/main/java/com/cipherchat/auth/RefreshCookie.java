package com.cipherchat.auth;

import java.time.Duration;
import java.util.Optional;

import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

/**
 * The refresh token's only home: an httpOnly, SameSite=Lax cookie scoped to
 * the auth path — invisible to scripts, never sent to any other endpoint.
 */
@Component
public class RefreshCookie {

    public static final String NAME = "CC_Refresh";
    static final String PATH = "/api/v1/auth";

    private final SecurityProperties props;

    public RefreshCookie(SecurityProperties props) {
        this.props = props;
    }

    public void set(HttpServletResponse response, String rawToken) {
        response.addHeader("Set-Cookie", build(rawToken, props.refreshTokenTtl()).toString());
    }

    public void clear(HttpServletResponse response) {
        response.addHeader("Set-Cookie", build("", Duration.ZERO).toString());
    }

    public Optional<String> read(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return Optional.empty();
        for (Cookie c : cookies) {
            if (NAME.equals(c.getName()) && c.getValue() != null && !c.getValue().isEmpty()) {
                return Optional.of(c.getValue());
            }
        }
        return Optional.empty();
    }

    private ResponseCookie build(String value, Duration maxAge) {
        return ResponseCookie.from(NAME, value)
                .httpOnly(true)
                .secure(props.cookieSecure())
                .sameSite("Lax")
                .path(PATH)
                .maxAge(maxAge)
                .build();
    }
}
