package com.cipherchat.ai;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class PiiGuardTest {

    @Test
    void redactedTranscriptIsClean() {
        assertThat(PiiGuard.scan("[PERSON_1]: mail [EMAIL_1] or call [PHONE_1]; card [CARD_1], chart [MRN_1] at [URL_1]"))
                .isEmpty();
    }

    @Test
    void survivingIdentifiersAreNamed() {
        assertThat(PiiGuard.scan("reach me at anika.rao@clinic.org or +91 98765 43210"))
                .containsExactly("EMAIL", "PHONE");
        assertThat(PiiGuard.scan("SSN 123-45-6789, MRN: AB-99812")).containsExactly("GOV_ID", "MRN");
    }

    @Test
    void onlyLuhnValidDigitRunsCountAsCards() {
        assertThat(PiiGuard.scan("card 4111 1111 1111 1111")).contains("CARD");
        assertThat(PiiGuard.scan("order 1234 5678 9012 3456 shipped")).doesNotContain("CARD");
    }

    @Test
    void ordinaryNumbersDoNotTrip() {
        assertThat(PiiGuard.scan("Build 4.1.1 passed 153 tests at 10:45 on 2026-09-19; p95 was 64 ms.")).isEmpty();
        assertThat(PiiGuard.scan(null)).isEmpty();
    }
}
