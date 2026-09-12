package com.cipherchat.shared.web;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

class OriginsTest {

    @Test
    void keepsSchemedOriginsAndTrimsSlashes() {
        assertThat(Origins.parse(" http://localhost:3000/ , https://app.example.com "))
                .containsExactly("http://localhost:3000", "https://app.example.com");
    }

    @Test
    void bareHostBecomesHttpsOrigin() {
        assertThat(Origins.parse("cipherchat-frontend.onrender.com"))
                .containsExactly("https://cipherchat-frontend.onrender.com");
    }

    @Test
    void blanksAreIgnored() {
        assertThat(Origins.parse(",, ,")).isEmpty();
        assertThat(Origins.parse(null)).isEmpty();
    }
}
