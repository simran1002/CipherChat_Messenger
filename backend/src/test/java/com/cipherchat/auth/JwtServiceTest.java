package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Duration;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.cipherchat.shared.security.AuthenticatedUser;

class JwtServiceTest {

    private static final String SECRET = "jwt-secret-that-is-long-enough-for-hmac-256!";

    private static JwtService service(Duration accessTtl, Duration pendingTtl) {
        return new JwtService(new SecurityProperties(SECRET, accessTtl, Duration.ofDays(30), pendingTtl, "seal-x", false));
    }

    @Test
    void accessTokenRoundTripsIdentityAndRole() {
        JwtService jwt = service(Duration.ofMinutes(15), Duration.ofMinutes(5));
        UUID id = UUID.randomUUID();
        String token = jwt.issueAccessToken(new AuthenticatedUser(id, "a@b.c", "ADMIN"));

        assertThat(jwt.parseAccessToken(token)).hasValueSatisfying(u -> {
            assertThat(u.id()).isEqualTo(id);
            assertThat(u.email()).isEqualTo("a@b.c");
            assertThat(u.role()).isEqualTo("ADMIN");
        });
    }

    @Test
    void twoFactorPendingTokenIsNotAnAccessToken_andViceVersa() {
        JwtService jwt = service(Duration.ofMinutes(15), Duration.ofMinutes(5));
        UUID id = UUID.randomUUID();
        String pending = jwt.issueTwoFactorPendingToken(id);
        String access = jwt.issueAccessToken(new AuthenticatedUser(id, "a@b.c", "USER"));

        assertThat(jwt.parseAccessToken(pending)).isEmpty();            // scoped token refused on API paths
        assertThat(jwt.parseTwoFactorPendingToken(pending)).contains(id);
        assertThat(jwt.parseTwoFactorPendingToken(access)).isEmpty();   // full token refused on the 2FA step
    }

    @Test
    void expiredTokensAreRejected() {
        JwtService jwt = service(Duration.ofSeconds(-60), Duration.ofSeconds(-60));
        UUID id = UUID.randomUUID();
        assertThat(jwt.parseAccessToken(jwt.issueAccessToken(new AuthenticatedUser(id, "a@b.c", "USER")))).isEmpty();
        assertThat(jwt.parseTwoFactorPendingToken(jwt.issueTwoFactorPendingToken(id))).isEmpty();
    }

    @Test
    void tokensSignedWithAnotherSecretAreRejected() {
        JwtService a = service(Duration.ofMinutes(15), Duration.ofMinutes(5));
        JwtService b = new JwtService(new SecurityProperties("another-secret-that-is-also-long-enough!!",
                Duration.ofMinutes(15), Duration.ofDays(30), Duration.ofMinutes(5), "seal-x", false));
        String token = a.issueAccessToken(new AuthenticatedUser(UUID.randomUUID(), "a@b.c", "USER"));
        assertThat(b.parseAccessToken(token)).isEmpty();
        assertThat(b.parseAccessToken("not.a.jwt")).isEmpty();
        assertThat(b.parseAccessToken("")).isEmpty();
    }
}
