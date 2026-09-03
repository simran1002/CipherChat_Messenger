package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.Base64;

import org.junit.jupiter.api.Test;

class SecretBoxTest {

    private static SecurityProperties props(String seal) {
        return new SecurityProperties("jwt-secret-that-is-long-enough-for-hmac-256!", Duration.ofMinutes(15),
                Duration.ofDays(30), Duration.ofMinutes(5), seal, false);
    }

    @Test
    void roundTripsAndRandomisesTheIv() {
        SecretBox box = new SecretBox(props("seal-secret-that-is-long-enough-for-tests!!"));
        String a = box.seal("JBSWY3DPEHPK3PXP");
        String b = box.seal("JBSWY3DPEHPK3PXP");
        assertThat(a).isNotEqualTo(b);                       // fresh IV per seal
        assertThat(box.open(a)).isEqualTo("JBSWY3DPEHPK3PXP");
        assertThat(box.open(b)).isEqualTo("JBSWY3DPEHPK3PXP");
    }

    @Test
    void tamperingIsDetected_gcmTagFails() {
        SecretBox box = new SecretBox(props("seal-secret-that-is-long-enough-for-tests!!"));
        byte[] raw = Base64.getDecoder().decode(box.seal("secret"));
        raw[raw.length - 1] ^= 0x01;                          // flip a tag bit
        String tampered = Base64.getEncoder().encodeToString(raw);
        assertThatThrownBy(() -> box.open(tampered)).isInstanceOf(RuntimeException.class);
    }

    @Test
    void aDifferentSealSecretCannotOpen() {
        SecretBox one = new SecretBox(props("seal-secret-number-one-long-enough-for-tests"));
        SecretBox two = new SecretBox(props("seal-secret-number-two-long-enough-for-tests"));
        String sealed = one.seal("totp-seed");
        assertThatThrownBy(() -> two.open(sealed)).isInstanceOf(RuntimeException.class);
    }
}
