package com.cipherchat.auth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;

import com.cipherchat.AbstractIntegrationTest;

class AuthFlowIT extends AbstractIntegrationTest {

    @Test
    void registerLoginAndReadProfile() {
        Session s = register("Ada Lovelace");
        assertThat(s.token()).isNotBlank();
        assertThat(s.refreshCookie()).startsWith("CC_Refresh=");

        ResponseEntity<Map> me = http().get().uri("/api/v1/users/me")
                .header(HttpHeaders.AUTHORIZATION, s.bearer()).retrieve().toEntity(Map.class);
        assertThat(me.getStatusCode().value()).isEqualTo(200);
        assertThat(me.getBody()).containsEntry("email", s.email()).containsEntry("name", "Ada Lovelace")
                .doesNotContainKey("passwordHash");

        ResponseEntity<Map> login = http().post().uri("/api/v1/auth/login")
                .body(Map.of("email", s.email(), "password", "correct horse battery staple"))
                .retrieve().toEntity(Map.class);
        assertThat(login.getStatusCode().value()).isEqualTo(200);
        assertThat(login.getBody()).containsKey("token");
    }

    @Test
    void wrongPasswordIsA401ProblemDetail_withStableCode() {
        Session s = register("Bad Pass");
        ResponseEntity<Map> res = http().post().uri("/api/v1/auth/login")
                .body(Map.of("email", s.email(), "password", "definitely-not-it"))
                .retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isEqualTo(401);
        assertThat(res.getHeaders().getContentType().toString()).contains("problem+json");
        assertThat(res.getBody()).containsEntry("code", "bad_credentials").containsKey("requestId");
    }

    @Test
    void unauthenticatedRequestsAreRejected() {
        ResponseEntity<Map> res = http().get().uri("/api/v1/users/me").retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isEqualTo(401);

        ResponseEntity<Map> bad = http().get().uri("/api/v1/users/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer nope.nope.nope").retrieve().toEntity(Map.class);
        assertThat(bad.getStatusCode().value()).isEqualTo(401);
    }

    @Test
    void refreshRotates_andAReplayedCookieIsRejected() {
        Session s = register("Rotator");

        ResponseEntity<Map> first = http().post().uri("/api/v1/auth/refresh")
                .header(HttpHeaders.COOKIE, s.refreshCookie()).retrieve().toEntity(Map.class);
        assertThat(first.getStatusCode().value()).isEqualTo(200);
        assertThat(first.getBody()).containsKey("token");
        String rotated = firstCookie(first.getHeaders(), "CC_Refresh");
        assertThat(rotated).isNotNull().isNotEqualTo(s.refreshCookie());

        // The consumed token must not work twice — that's the whole point of rotation.
        ResponseEntity<Map> replay = http().post().uri("/api/v1/auth/refresh")
                .header(HttpHeaders.COOKIE, s.refreshCookie()).retrieve().toEntity(Map.class);
        assertThat(replay.getStatusCode().value()).isEqualTo(401);
        assertThat(replay.getBody()).containsEntry("code", "refresh_invalid");

        // …while the rotated one does.
        ResponseEntity<Map> second = http().post().uri("/api/v1/auth/refresh")
                .header(HttpHeaders.COOKIE, rotated).retrieve().toEntity(Map.class);
        assertThat(second.getStatusCode().value()).isEqualTo(200);
    }

    @Test
    void logoutRevokesTheRefreshToken() {
        Session s = register("Leaver");
        ResponseEntity<Map> out = http().post().uri("/api/v1/auth/logout")
                .header(HttpHeaders.AUTHORIZATION, s.bearer())
                .header(HttpHeaders.COOKIE, s.refreshCookie()).retrieve().toEntity(Map.class);
        assertThat(out.getStatusCode().value()).isEqualTo(200);

        ResponseEntity<Map> refresh = http().post().uri("/api/v1/auth/refresh")
                .header(HttpHeaders.COOKIE, s.refreshCookie()).retrieve().toEntity(Map.class);
        assertThat(refresh.getStatusCode().value()).isEqualTo(401);
    }

    @Test
    void validationErrorsListFields() {
        ResponseEntity<Map> res = http().post().uri("/api/v1/auth/register")
                .body(Map.of("name", "", "email", "not-an-email", "password", "short"))
                .retrieve().toEntity(Map.class);
        assertThat(res.getStatusCode().value()).isEqualTo(400);
        assertThat(res.getBody()).containsEntry("code", "validation_failed");
        @SuppressWarnings("unchecked")
        Map<String, Object> fields = (Map<String, Object>) res.getBody().get("fields");
        assertThat(fields).containsKeys("name", "email", "password");
    }
}
