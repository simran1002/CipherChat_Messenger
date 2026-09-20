package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;

import com.cipherchat.AbstractIntegrationTest;

/**
 * Refresh-token reuse detection over the real stack. Rotation used to DELETE the consumed row, so a
 * stolen-and-replayed token was indistinguishable from an unknown one and the thief's own rotated token
 * stayed valid. Tokens now form a family per sign-in; presenting a used token outside the short two-tab
 * grace window revokes the whole family.
 */
class RefreshReuseIT extends AbstractIntegrationTest {

    @Autowired
    JdbcClient jdbc;

    private ResponseEntity<Map> refresh(String cookie) {
        return http().post().uri("/api/v1/auth/refresh").header(HttpHeaders.COOKIE, cookie).retrieve().toEntity(Map.class);
    }

    /** Pretend the rotation happened a minute ago, i.e. well outside the grace window. */
    private void ageConsumedTokens(Session s) {
        int aged = jdbc.sql("update refresh_tokens set used_at = now() - interval '1 minute' where user_id = :u and used_at is not null")
                .param("u", s.id()).update();
        assertThat(aged).as("rows marked used by the rotation").isGreaterThanOrEqualTo(1);
    }

    private long liveTokens(Session s) {
        return jdbc.sql("select count(*) from refresh_tokens where user_id = :u").param("u", s.id()).query(Long.class).single();
    }

    @Test
    void aSiblingTabRacingTheSameCookie_isRefusedButNothingIsRevoked() {
        Session s = register("Racer");

        ResponseEntity<Map> first = refresh(s.refreshCookie());
        assertThat(first.getStatusCode().value()).isEqualTo(200);
        String rotated = firstCookie(first.getHeaders(), "CC_Refresh");

        // The loser of the race presents the cookie the winner just consumed: refused, but inside the grace
        // window this is not evidence of theft, so the winner's fresh token must keep working.
        ResponseEntity<Map> loser = refresh(s.refreshCookie());
        assertThat(loser.getStatusCode().value()).isEqualTo(401);
        assertThat(refresh(rotated).getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void replayingAConsumedTokenAfterTheGraceWindow_revokesTheWholeFamily_thiefIncluded() {
        Session victim = register("Victim");

        // The legitimate owner rotates; the thief, holding the ORIGINAL cookie, then rotates that.
        ResponseEntity<Map> ownersRotation = refresh(victim.refreshCookie());
        String ownersLiveCookie = firstCookie(ownersRotation.getHeaders(), "CC_Refresh");
        assertThat(ownersLiveCookie).isNotNull();
        ageConsumedTokens(victim);

        ResponseEntity<Map> theft = refresh(victim.refreshCookie());
        assertThat(theft.getStatusCode().value()).isEqualTo(401);
        assertThat(theft.getBody()).containsEntry("code", "refresh_invalid");
        // The rejected client is told to drop its cookie.
        assertThat(theft.getHeaders().getOrEmpty(HttpHeaders.SET_COOKIE)).anyMatch(c -> c.startsWith("CC_Refresh=") && c.contains("Max-Age=0"));

        // Both parties are signed out: the owner's live token died with the family, so the owner must sign in
        // again — the price of not being able to tell owner from thief — and no rows are left to replay.
        assertThat(refresh(ownersLiveCookie).getStatusCode().value()).isEqualTo(401);
        assertThat(liveTokens(victim)).isZero();
    }

    @Test
    void revokingOneFamilyLeavesTheUsersOtherDevicesSignedIn() {
        Session laptop = register("Two Devices");
        ResponseEntity<Map> phoneLogin = http().post().uri("/api/v1/auth/login")
                .body(Map.of("email", laptop.email(), "password", "correct horse battery staple")).retrieve().toEntity(Map.class);
        assertThat(phoneLogin.getStatusCode().value()).isEqualTo(200);
        String phoneCookie = firstCookie(phoneLogin.getHeaders(), "CC_Refresh");

        // Attack the laptop's family.
        refresh(laptop.refreshCookie());
        ageConsumedTokens(laptop);
        assertThat(refresh(laptop.refreshCookie()).getStatusCode().value()).isEqualTo(401);

        // The phone is a different sign-in, hence a different family: untouched.
        assertThat(refresh(phoneCookie).getStatusCode().value()).isEqualTo(200);
    }
}
