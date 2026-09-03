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
 * Minimal chat-completions client over {@link RestClient} — no SDK, one
 * endpoint ({@code POST {AI_BASE_URL}/v1/chat/completions}), explicit
 * timeouts. The wire format is the de-facto standard that self-hosted
 * servers (Ollama, vLLM, LM Studio, llama.cpp) and most hosted providers
 * speak, so an operator points {@code AI_BASE_URL} at whatever they run.
 * Resilience4j wraps it: retry once on transport/5xx, then the circuit
 * opens after 50% failures in the last 10 calls and every caller gets an
 * immediate, cheap 503 for 30 s.
 */
@Component
@EnableConfigurationProperties(LlmClient.Properties.class)
public class LlmClient {

    private static final Logger log = LoggerFactory.getLogger(LlmClient.class);
    static final String CIRCUIT = "llm";

    @ConfigurationProperties("cipherchat.ai")
    public record Properties(String baseUrl, String model, String apiKey, int requestsPerMinute) {
        boolean configured() {
            return baseUrl != null && !baseUrl.isBlank() && model != null && !model.isBlank();
        }

        boolean hasApiKey() {
            return apiKey != null && !apiKey.isBlank();
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    record Response(List<Choice> choices) {
        @JsonIgnoreProperties(ignoreUnknown = true)
        record Choice(Message message) {
        }

        @JsonIgnoreProperties(ignoreUnknown = true)
        record Message(String content) {
        }

        String firstText() {
            if (choices == null) return "";
            return choices.stream()
                    .filter(c -> c.message() != null && c.message().content() != null)
                    .map(c -> c.message().content()).findFirst().orElse("");
        }
    }

    private final Properties props;
    private final RestClient http;

    public LlmClient(Properties props) {
        this.props = props;
        var factory = new JdkClientHttpRequestFactory();
        factory.setReadTimeout(Duration.ofSeconds(25));
        var builder = RestClient.builder()
                .baseUrl(props.configured() ? props.baseUrl().replaceAll("/+$", "") : "http://ai-not-configured.invalid")
                .requestFactory(factory)
                .defaultHeader("content-type", "application/json");
        if (props.hasApiKey()) {
            builder.defaultHeader("authorization", "Bearer " + props.apiKey());
        }
        this.http = builder.build();
    }

    boolean configured() {
        return props.configured();
    }

    @Retry(name = CIRCUIT)
    @CircuitBreaker(name = CIRCUIT, fallbackMethod = "unavailable")
    public String complete(String prompt, int maxTokens) {
        if (!props.configured()) {
            throw new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "ai_not_configured",
                    "AI assist is not configured. Set AI_BASE_URL and AI_MODEL (and AI_API_KEY if the provider needs one) on the backend.");
        }
        Response r = http.post().uri("/v1/chat/completions")
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
