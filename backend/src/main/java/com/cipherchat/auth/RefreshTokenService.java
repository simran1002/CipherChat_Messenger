package com.cipherchat.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Rotating refresh tokens.
 *
 * <p>The raw token is 256 random bits that only ever live in an httpOnly
 * cookie; the database stores its SHA-256, so a dump cannot be replayed as a
 * session. Every refresh consumes the presented row and inserts a fresh one.
 * Presenting an already-consumed token means either a stale duplicate client
 * or a thief — in both cases the answer is "sign in again".
 */
@Service
@Transactional
public class RefreshTokenService {

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenService.class);
    private static final SecureRandom RANDOM = new SecureRandom();

    public record Issued(String rawToken, Instant expiresAt) {
    }

    public record SessionView(UUID id, Instant createdAt, Instant expiresAt, String createdByIp, boolean current) {
    }

    private final RefreshTokenRepository tokens;
    private final SecurityProperties props;

    public RefreshTokenService(RefreshTokenRepository tokens, SecurityProperties props) {
        this.tokens = tokens;
        this.props = props;
    }

    public Issued issue(UUID userId, String ip) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        Instant expiresAt = Instant.now().plus(props.refreshTokenTtl());
        tokens.save(new RefreshToken(userId, hash(raw), expiresAt, ip));
        return new Issued(raw, expiresAt);
    }

    /** Consume the presented token and mint a replacement; empty = invalid/expired/replayed. */
    public Optional<Issued> rotate(String rawToken, String ip) {
        String h = hash(rawToken);
        Optional<RefreshToken> row = tokens.findByTokenHash(h);
        if (row.isEmpty()) {
            return Optional.empty();
        }
        if (tokens.consume(h, Instant.now()) != 1) {
            // Row vanished between lookup and delete: a concurrent presenter won — replay.
            log.warn("Refresh token replay detected userId={}", row.get().getUserId());
            return Optional.empty();
        }
        return Optional.of(issue(row.get().getUserId(), ip));
    }

    public Optional<UUID> ownerOf(String rawToken) {
        return tokens.findByTokenHash(hash(rawToken)).map(RefreshToken::getUserId);
    }

    public void revoke(String rawToken) {
        tokens.deleteByTokenHash(hash(rawToken));
    }

    public void revokeAll(UUID userId) {
        tokens.deleteByUserId(userId);
    }

    @Transactional(readOnly = true)
    public List<SessionView> sessions(UUID userId, String currentRawToken) {
        String current = currentRawToken == null ? null : hash(currentRawToken);
        return tokens.findAllByUserIdAndExpiresAtAfterOrderByCreatedAtDesc(userId, Instant.now()).stream()
                .map(t -> new SessionView(t.getId(), t.getCreatedAt(), t.getExpiresAt(), t.getCreatedByIp(),
                        current != null && current.equals(t.getTokenHash())))
                .toList();
    }

    public boolean revokeSession(UUID userId, UUID sessionId) {
        return tokens.deleteByIdAndUserId(sessionId, userId) == 1;
    }

    public int revokeOthers(UUID userId, String currentRawToken) {
        return currentRawToken == null ? tokens.deleteByUserId(userId) : tokens.deleteAllByUserIdExcept(userId, hash(currentRawToken));
    }

    /** Postgres has no TTL index — sweep expired sessions hourly (Mongo did this implicitly). */
    @Scheduled(fixedDelayString = "PT1H", initialDelayString = "PT5M")
    public void sweepExpired() {
        int n = tokens.deleteExpired(Instant.now());
        if (n > 0) log.info("Swept {} expired refresh tokens", n);
    }

    static String hash(String raw) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(raw.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
