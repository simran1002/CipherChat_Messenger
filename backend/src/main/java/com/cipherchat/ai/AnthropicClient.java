package com.cipherchat.ai;

import java.time.Duration;
import java.util.List;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.http.HttpStatus;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;

import com.cipherchat.shared.api.ApiException;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import io.github.resilience4j.circuitbreaker.CallNotPermittedException;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;

/**
 * Minimal Messages-API client over {@link RestClient} — no SDK, one
 * endpoint, explicit timeouts. Resilience4j wraps it: retry once on
 * transport/5xx, then the circuit opens after 50% failures in the last 10
 * calls and every caller gets an immediate, cheap 503 for 30 s.
 */
@Component
@EnableConfigurationProperties(AnthropicClient.Properties.class)
public class AnthropicClient {

    private static final Logger log = LoggerFactory.getLogger(AnthropicClient.class);
    static final String CIRCUIT = "anthropic";

    @ConfigurationProperties("cipherchat.ai")
    public record Properties(String apiKey, String baseUrl, String model, int requestsPerMinute) {
        boolean configured() {
            return apiKey != null && !apiKey.isBlank();
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Response(List<Block> content) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Block(String type, String text) {
        }

        String firstText() {
            if (content == null) return "";
            return content.stream().filter(b -> "text".equals(b.type()) && b.text() != null)
                    .map(Block::text).findFirst().orElse("");
        }
    }

    private final Properties props;
    private final RestClient http;

    public AnthropicClient(Properties props) {
        this.props = props;
        var factory = new JdkClientHttpRequestFactory();
        factory.setReadTimeout(Duration.ofSeconds(25));
        this.http = RestClient.builder()
                .baseUrl(props.baseUrl().replaceAll("/+$", ""))
                .requestFactory(factory)
                .defaultHeader("anthropic-version", "2023-06-01")
                .defaultHeader("content-type", "application/json")
                .build();
    }

    boolean configured() {
        return props.configured();
    }

    @Retry(name = CIRCUIT)
    @CircuitBreaker(name = CIRCUIT, fallbackMethod = "unavailable")
    public String complete(String prompt, int maxTokens) {
        if (!props.configured()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "ai_not_configured", "ANTHROPIC_API_KEY not configured. Add it to the environment to use AI features.");
        }
        Response r = http.post().uri("/v1/messages")
                .header("x-api-key", props.apiKey())
                .body(Map.of(
                        "model", props.model(),
                        "max_tokens", maxTokens,
                        "messages", List.of(Map.of("role", "user", "content", prompt))))
                .retrieve()
                .body(Response.class);
        return r == null ? "" : r.firstText();
    }

    /** Circuit open — fail fast without touching the network. Only this exception type is caught. */
    @SuppressWarnings("unused")
    private String unavailable(String prompt, int maxTokens, CallNotPermittedException e) {
        log.warn("AI circuit open; rejecting request");
        throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "ai_unavailable", "AI assistant is temporarily unavailable. Try again shortly.");
    }
}
