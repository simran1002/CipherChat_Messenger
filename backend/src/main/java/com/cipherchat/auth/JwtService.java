package com.cipherchat.auth;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.Optional;
import java.util.UUID;

import javax.crypto.SecretKey;

import org.springframework.stereotype.Service;

import com.cipherchat.shared.security.AuthenticatedUser;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;

/**
 * HS256 access tokens (short-lived) and scoped 2FA-pending tokens.
 *
 * <p>An access token is exactly {sub, email, role, iat, exp}. A pending
 * token additionally carries {@code scope=2fa-pending}, and
 * {@link #parseAccessToken} rejects <em>any</em> token bearing a scope claim
 * — so the token issued after a correct password but before the second
 * factor is structurally incapable of authenticating a request. There is no
 * allowlist to forget.
 */
@Service
public class JwtService {

    private static final String SCOPE = "scope";
    private static final String TWO_FACTOR_SCOPE = "2fa-pending";

    private final SecretKey key;
    private final SecurityProperties props;

    public JwtService(SecurityProperties props) {
        this.props = props;
        this.key = Keys.hmacShaKeyFor(props.jwtSecret().getBytes(StandardCharsets.UTF_8));
    }

    public String issueAccessToken(AuthenticatedUser user) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(user.id().toString())
                .claim("email", user.email())
                .claim("role", user.role())
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(props.accessTokenTtl())))
                .signWith(key)
                .compact();
    }

    public String issueTwoFactorPendingToken(UUID userId) {
        Instant now = Instant.now();
        return Jwts.builder()
                .subject(userId.toString())
                .claim(SCOPE, TWO_FACTOR_SCOPE)
                .issuedAt(Date.from(now))
                .expiration(Date.from(now.plus(props.twoFactorPendingTtl())))
                .signWith(key)
                .compact();
    }

    /** Empty for expired, tampered, malformed — or scoped — tokens. */
    public Optional<AuthenticatedUser> parseAccessToken(String token) {
        return parse(token).filter(c -> c.get(SCOPE) == null).map(c ->
                new AuthenticatedUser(UUID.fromString(c.getSubject()), c.get("email", String.class), c.get("role", String.class)));
    }

    public Optional<UUID> parseTwoFactorPendingToken(String token) {
        return parse(token)
                .filter(c -> TWO_FACTOR_SCOPE.equals(c.get(SCOPE, String.class)))
                .map(c -> UUID.fromString(c.getSubject()));
    }

    private Optional<Claims> parse(String token) {
        try {
            return Optional.of(Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload());
        } catch (JwtException | IllegalArgumentException e) {
            return Optional.empty();
        }
    }
}
