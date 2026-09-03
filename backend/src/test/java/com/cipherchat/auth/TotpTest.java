package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;

import org.junit.jupiter.api.Test;

class TotpTest {

    /** RFC 6238 Appendix B secret "12345678901234567890" in base32. */
    private static final String RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    @Test
    void matchesRfc6238TestVectors() {
        // RFC vectors are 8 digits; a 6-digit code is the same HOTP truncated to the last six.
        assertThat(Totp.code(RFC_SECRET, 59 / 30)).isEqualTo("287082");          // T=59      → 94287082
        assertThat(Totp.code(RFC_SECRET, 1111111109L / 30)).isEqualTo("081804"); // T=1111111109 → 07081804
        assertThat(Totp.code(RFC_SECRET, 1234567890L / 30)).isEqualTo("005924"); // T=1234567890 → 89005924
        assertThat(Totp.code(RFC_SECRET, 2000000000L / 30)).isEqualTo("279037"); // T=2000000000 → 69279037
    }

    @Test
    void acceptsCurrentAndAdjacentSteps_rejectsFurther() {
        String secret = Totp.generateSecret();
        Instant now = Instant.ofEpochSecond(1_700_000_000L);
        long step = now.getEpochSecond() / 30;

        assertThat(Totp.verify(secret, Totp.code(secret, step), now)).isTrue();
        assertThat(Totp.verify(secret, Totp.code(secret, step - 1), now)).isTrue();   // clock drift tolerance
        assertThat(Totp.verify(secret, Totp.code(secret, step + 1), now)).isTrue();
        assertThat(Totp.verify(secret, Totp.code(secret, step - 2), now)).isFalse();
        assertThat(Totp.verify(secret, Totp.code(secret, step + 2), now)).isFalse();
    }

    @Test
    void rejectsMalformedCodes() {
        String secret = Totp.generateSecret();
        Instant now = Instant.now();
        assertThat(Totp.verify(secret, null, now)).isFalse();
        assertThat(Totp.verify(secret, "12345", now)).isFalse();
        assertThat(Totp.verify(secret, "abcdef", now)).isFalse();
        assertThat(Totp.verify(secret, "1234567", now)).isFalse();
    }

    @Test
    void secretsAreBase32AndUnique() {
        String a = Totp.generateSecret();
        String b = Totp.generateSecret();
        assertThat(a).matches("[A-Z2-7]{32}");
        assertThat(a).isNotEqualTo(b);
    }
}
