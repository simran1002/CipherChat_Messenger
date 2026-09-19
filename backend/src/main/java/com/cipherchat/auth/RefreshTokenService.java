package com.cipherchat.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Rotating refresh tokens with reuse detection.
 *
 * <p>The raw token is 256 random bits that only ever live in an httpOnly
 * cookie; the database stores its SHA-256, so a dump cannot be replayed as a
 * session. Every refresh marks the presented row used and inserts a fresh one
 * in the same <b>family</b> (one family per sign-in).
 *
 * <p>A used token presented again means two parties hold the same cookie. The
 * server cannot tell which one is the owner, so it revokes the whole family:
 * the thief's live token dies with it and the owner signs in again. The one
 * benign cause — two tabs refreshing the same cookie at the same moment — is
 * absorbed by a short grace window in which the loser is simply refused.
 */
@Service
@Transactional
public class RefreshTokenService {

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenService.class);
    private static final SecureRandom RANDOM = new SecureRandom();
    /** Two tabs sharing one cookie can legitimately present the same token within moments of each other. */
    static final Duration REUSE_GRACE = Duration.ofSeconds(10);
    static final Duration USED_ROW_RETENTION = Duration.ofDays(7);

    public record Issued(String rawToken, Instant expiresAt) {
    }

    public enum Outcome { ROTATED, UNKNOWN, CONCURRENT, REUSED }

    /** {@code userId} is known for every outcome except UNKNOWN, so a rejected refresh can be audited against its account. */
    public record Rotation(Outcome outcome, UUID userId, Issued issued, int revokedSessions) {
        public boolean ok() {
            return outcome == Outcome.ROTATED;
        }
    }

    public record SessionView(UUID id, Instant createdAt, Instant expiresAt, String createdByIp, boolean current) {
    }

    private final RefreshTokenRepository tokens;
    private final SecurityProperties props;
    private final TransactionTemplate isolated;

    public RefreshTokenService(RefreshTokenRepository tokens, SecurityProperties props, PlatformTransactionManager txManager) {
        this.tokens = tokens;
        this.props = props;
        this.isolated = new TransactionTemplate(txManager);
        this.isolated.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
    }

    /** A new sign-in: a new family. */
    public Issued issue(UUID userId, String ip) {
        return issue(userId, ip, UUID.randomUUID());
    }

    private Issued issue(UUID userId, String ip, UUID familyId) {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        String raw = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
        Instant expiresAt = Instant.now().plus(props.refreshTokenTtl());
        tokens.save(new RefreshToken(userId, hash(raw), expiresAt, ip, familyId));
        return new Issued(raw, expiresAt);
    }

    /** Consume the presented token and mint its successor in the same family. */
    public Rotation rotate(String rawToken, String ip) {
        String h = hash(rawToken);
        Instant now = Instant.now();
        RefreshToken row = tokens.findByTokenHash(h).orElse(null);
        if (row == null || !row.getExpiresAt().isAfter(now)) {
            return new Rotation(Outcome.UNKNOWN, row == null ? null : row.getUserId(), null, 0);
        }
        if (row.getUsedAt() == null && tokens.markUsed(h, now) == 1) {
            return new Rotation(Outcome.ROTATED, row.getUserId(), issue(row.getUserId(), ip, row.getFamilyId()), 0);
        }
        // Already used: by a sibling tab a moment ago, or by someone else entirely.
        Instant usedAt = row.getUsedAt() != null ? row.getUsedAt() : now;
        if (Duration.between(usedAt, now).compareTo(REUSE_GRACE) <= 0) {
            return new Rotation(Outcome.CONCURRENT, row.getUserId(), null, 0);
        }
        // The caller answers 401 by throwing, which rolls its transaction back — the revocation must not go with it.
        Integer revoked = isolated.execute(status -> tokens.deleteByFamilyId(row.getFamilyId()));
        log.warn("Refresh token reuse detected userId={} familyId={} sessionsRevoked={}", row.getUserId(), row.getFamilyId(), revoked);
        return new Rotation(Outcome.REUSED, row.getUserId(), null, revoked == null ? 0 : revoked);
    }

    public void revoke(String rawToken) {
        tokens.findByTokenHash(hash(rawToken)).ifPresent(t -> tokens.deleteByFamilyId(t.getFamilyId()));
    }

    public void revokeAll(UUID userId) {
        tokens.deleteByUserId(userId);
    }

    @Transactional(readOnly = true)
    public List<SessionView> sessions(UUID userId, String currentRawToken) {
        String current = currentRawToken == null ? null : hash(currentRawToken);
        return tokens.findAllByUserIdAndUsedAtIsNullAndExpiresAtAfterOrderByCreatedAtDesc(userId, Instant.now()).stream()
                .map(t -> new SessionView(t.getId(), t.getCreatedAt(), t.getExpiresAt(), t.getCreatedByIp(),
                        current != null && current.equals(t.getTokenHash())))
                .toList();
    }

    /** Revoking a session removes its whole family, so an older copy of its cookie cannot resurface as a reuse alarm. */
    public boolean revokeSession(UUID userId, UUID sessionId) {
        return tokens.findByIdAndUserId(sessionId, userId)
                .map(t -> tokens.deleteByFamilyId(t.getFamilyId()) > 0)
                .orElse(false);
    }

    /** @return number of live sessions that were signed out */
    public int revokeOthers(UUID userId, String currentRawToken) {
        UUID keepFamily = currentRawToken == null ? null
                : tokens.findByTokenHash(hash(currentRawToken)).map(RefreshToken::getFamilyId).orElse(null);
        int live = (int) tokens.findAllByUserIdAndUsedAtIsNullAndExpiresAtAfterOrderByCreatedAtDesc(userId, Instant.now()).stream()
                .filter(t -> !t.getFamilyId().equals(keepFamily))
                .count();
        if (keepFamily == null) {
            tokens.deleteByUserId(userId);
        } else {
            tokens.deleteAllByUserIdExceptFamily(userId, keepFamily);
        }
        return live;
    }

    /** Postgres has no TTL index — sweep expired rows (live and used alike) hourly. */
    @Scheduled(fixedDelayString = "PT1H", initialDelayString = "PT5M")
    public void sweepExpired() {
        Instant now = Instant.now();
        int n = tokens.deleteExpired(now, now.minus(USED_ROW_RETENTION));
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
