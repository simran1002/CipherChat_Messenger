package com.cipherchat.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.UUID;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.infra.RedisRateLimiter;

/**
 * Throttles the unauthenticated side of the API.
 *
 * <ul>
 *   <li><b>Per IP</b> across register/login/2FA — caps credential stuffing and the BCrypt CPU it costs.</li>
 *   <li><b>Per (IP, email)</b> on login — caps guessing at one account from one place. It is deliberately not
 *       per email alone: that would let anyone lock a victim out by failing logins in their name.</li>
 *   <li><b>Per account</b> on the second factor — reaching that step already required the password, so a
 *       strict budget protects the 6-digit code without handing strangers a lockout lever.</li>
 *   <li><b>Per IP</b> on refresh.</li>
 * </ul>
 *
 * Budgets are shared by every replica (one Redis token bucket each). Like every rate limit here they fail
 * open if Redis is down.
 */
@Component
public class AuthThrottle {

    private static final int LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP = 10;

    private final RedisRateLimiter limiter;
    private final int authPer15m;
    private final int refreshPer15m;
    private final int twoFactorPer5m;

    public AuthThrottle(RedisRateLimiter limiter,
                        @Value("${cipherchat.rate-limit.auth-per-15m}") int authPer15m,
                        @Value("${cipherchat.rate-limit.refresh-per-15m}") int refreshPer15m,
                        @Value("${cipherchat.rate-limit.two-factor-per-5m}") int twoFactorPer5m) {
        this.limiter = limiter;
        this.authPer15m = authPer15m;
        this.refreshPer15m = refreshPer15m;
        this.twoFactorPer5m = twoFactorPer5m;
    }

    public void credentials(String ip) {
        acquire("rl:auth:ip:" + ip, authPer15m, 900);
    }

    public void login(String ip, String email) {
        credentials(ip);
        acquire("rl:auth:login:" + ip + ":" + digest(email), LOGIN_ATTEMPTS_PER_ACCOUNT_AND_IP, 900);
    }

    public void refresh(String ip) {
        acquire("rl:auth:refresh:" + ip, refreshPer15m, 900);
    }

    public void twoFactor(UUID userId) {
        acquire("rl:auth:2fa:" + userId, twoFactorPer5m, 300);
    }

    private void acquire(String key, int capacity, int windowSeconds) {
        if (!limiter.tryAcquire(key, capacity, (double) capacity / windowSeconds)) {
            throw ApiException.tooManyRequests("Too many attempts. Wait a few minutes and try again.");
        }
    }

    /** Keys must not carry an email address into Redis or its logs. */
    private static String digest(String email) {
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(email.trim().toLowerCase().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d, 0, 12);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
