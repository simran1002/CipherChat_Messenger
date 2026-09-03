package com.cipherchat;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.condition.EnabledIf;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestClient;
import org.testcontainers.DockerClientFactory;

/**
 * Base for {@code *IT} tests: the real application on a random port against
 * real PostgreSQL, Redis and Kafka (Testcontainers). Skipped — not failed —
 * when Docker is unavailable so unit-only environments stay green.
 *
 * <p>Uses plain {@link RestClient} over HTTP so the tests exercise the exact
 * wire contract (status codes, ProblemDetail bodies, cookies) a browser sees.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Import(TestcontainersConfiguration.class)
@EnabledIf(value = "dockerAvailable", disabledReason = "Docker is required for integration tests")
public abstract class AbstractIntegrationTest {

    @LocalServerPort
    protected int port;

    static boolean dockerAvailable() {
        try {
            return DockerClientFactory.instance().isDockerAvailable();
        } catch (Throwable t) {
            return false;
        }
    }

    protected String baseUrl() {
        return "http://localhost:" + port;
    }

    /** Client that never throws on 4xx/5xx — assertions inspect the status explicitly. */
    protected RestClient http() {
        return RestClient.builder().baseUrl(baseUrl())
                .defaultStatusHandler(HttpStatusCode::isError, (req, res) -> { })
                .build();
    }

    /** A registered user: bearer token + the refresh cookie exactly as the server set it. */
    public record Session(UUID id, String email, String token, String refreshCookie) {
        public String bearer() {
            return "Bearer " + token;
        }
    }

    @SuppressWarnings("unchecked")
    protected Session register(String name) {
        String email = name.toLowerCase().replaceAll("[^a-z0-9]", "") + "-" + UUID.randomUUID() + "@it.test";
        ResponseEntity<Map> res = http().post().uri("/api/v1/auth/register")
                .body(Map.of("name", name, "email", email, "password", "correct horse battery staple"))
                .retrieve().toEntity(Map.class);
        if (res.getStatusCode().value() != 201) {
            throw new AssertionError("register failed: " + res.getStatusCode() + " " + res.getBody());
        }
        Map<String, Object> body = res.getBody();
        Map<String, Object> user = (Map<String, Object>) body.get("user");
        String cookie = firstCookie(res.getHeaders(), "CC_Refresh");
        return new Session(UUID.fromString((String) user.get("id")), email, (String) body.get("token"), cookie);
    }

    protected static String firstCookie(HttpHeaders headers, String name) {
        List<String> cookies = headers.getOrEmpty(HttpHeaders.SET_COOKIE);
        return cookies.stream().filter(c -> c.startsWith(name + "=")).map(c -> c.split(";", 2)[0]).findFirst().orElse(null);
    }
}
