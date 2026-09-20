package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import com.cipherchat.AbstractIntegrationTest;

/**
 * Login throttling over the real stack (Redis token buckets shared by every replica). The rate-limit
 * settings for auth existed in configuration but nothing read them, so password guessing was unbounded
 * and every wrong 2FA guess also cost several BCrypt comparisons.
 */
class AuthThrottleIT extends AbstractIntegrationTest {

    private ResponseEntity<Map> login(String email, String password) {
        return http().post().uri("/api/v1/auth/login").body(Map.of("email", email, "password", password)).retrieve().toEntity(Map.class);
    }

    @Test
    void repeatedWrongPasswordsAgainstOneAccountAreCutOff_beforeTheyBecomeAnUnboundedGuessingLoop() {
        Session victim = register("Guessed At");

        int throttledAt = -1;
        for (int attempt = 1; attempt <= 25; attempt++) {
            ResponseEntity<Map> res = login(victim.email(), "wrong-password-" + attempt);
            if (res.getStatusCode().value() == 429) {
                throttledAt = attempt;
                assertThat(res.getBody()).containsEntry("code", "rate_limited");
                break;
            }
            assertThat(res.getStatusCode().value()).isEqualTo(401);
        }
        // Budget is 10 per (address, account); the bucket refills slowly, so the cut-off lands right after it.
        assertThat(throttledAt).as("attempt at which the throttle engaged").isBetween(10, 13);

        // Once throttled, even the CORRECT password is refused for a while — that is what makes it a brake on guessing.
        assertThat(login(victim.email(), "correct horse battery staple").getStatusCode().value()).isEqualTo(429);
    }

    @Test
    void throttlingOneAccount_doesNotLockEveryoneElseOutFromTheSameAddress() {
        Session hammered = register("Hammered " + UUID.randomUUID().toString().substring(0, 4));
        Session bystander = register("Bystander " + UUID.randomUUID().toString().substring(0, 4));

        for (int i = 0; i < 15; i++) login(hammered.email(), "nope-" + i);
        assertThat(login(hammered.email(), "correct horse battery staple").getStatusCode().value()).isEqualTo(429);

        // Keyed by (address, account), not address alone: an attacker can't use it as a lock-out lever against others.
        assertThat(login(bystander.email(), "correct horse battery staple").getStatusCode().value()).isEqualTo(200);
    }
}
