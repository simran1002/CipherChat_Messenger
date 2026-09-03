package com.cipherchat.ai;

import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.chatroom.ChatroomDtos.MessageView;
import com.cipherchat.chatroom.Message;
import com.cipherchat.chatroom.MessageService;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.infra.RedisRateLimiter;
import com.cipherchat.shared.security.CurrentUser;
import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

import tools.jackson.databind.ObjectMapper;

/**
 * Prompt-injection note (all three endpoints): user text is interpolated
 * into the prompt, so "ignore the above and…" can steer the model. The
 * blast radius is bounded by design — the model only returns text the SAME
 * user sees, has no tools, and output is parsed defensively (regex-extract +
 * parse in try/catch, defaults on failure). Room access is checked by the
 * chatroom module before any transcript is read.
 */
@RestController
@RequestMapping("/api/v1/ai")
@Tag(name = "AI assist", description = "Room summaries, reply suggestions, tone check (rooms only — DMs are E2EE)")
public class AiController {

    private static final Logger log = LoggerFactory.getLogger(AiController.class);
    private static final Pattern JSON_ARRAY = Pattern.compile("\\[[\\s\\S]*]");
    private static final Pattern JSON_OBJECT = Pattern.compile("\\{[\\s\\S]*}");
    private static final List<String> DEFAULT_SUGGESTIONS = List.of("Sure, sounds good!", "I'll check that out.", "Thanks for sharing!");

    public record SummarizeRequest(Integer limit) {
    }

    public record ToneRequest(String message) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record ToneResult(String tone, String suggestion) {
    }

    private final AnthropicClient ai;
    private final MessageService messages;
    private final RedisRateLimiter rateLimiter;
    private final ObjectMapper json;
    private final int perMinute;

    public AiController(AnthropicClient ai, MessageService messages, RedisRateLimiter rateLimiter, ObjectMapper json,
                        AnthropicClient.Properties props) {
        this.ai = ai;
        this.messages = messages;
        this.rateLimiter = rateLimiter;
        this.json = json;
        this.perMinute = props.requestsPerMinute();
    }

    @PostMapping("/rooms/{roomId}/summarize")
    @Operation(summary = "Summarise the last N text messages of a room (3–5 bullets)")
    public Map<String, String> summarize(@PathVariable UUID roomId, @RequestBody(required = false) SummarizeRequest body) {
        UUID userId = throttle();
        int limit = body == null || body.limit() == null ? 50 : Math.min(Math.max(body.limit(), 1), 100);
        String transcript = transcript(roomId, userId, limit);
        if (transcript.isEmpty()) return Map.of("summary", "No messages to summarize yet.");
        String summary = ai.complete("Summarize this chat conversation in 3-5 bullet points. Be concise and focus on decisions, "
                + "key topics, and action items. Reply ONLY with the bullet points, no intro:\n\n" + transcript, 300);
        log.info("AI summary generated roomId={} userId={}", roomId, userId);
        return Map.of("summary", summary.isBlank() ? "Could not generate summary." : summary);
    }

    @PostMapping("/rooms/{roomId}/suggest-reply")
    @Operation(summary = "Three short contextual reply suggestions")
    public Map<String, List<String>> suggestReply(@PathVariable UUID roomId) {
        UUID userId = throttle();
        String transcript = transcript(roomId, userId, 10);
        if (transcript.isEmpty()) return Map.of("suggestions", List.of("Hello!", "Let's get started.", "Sure, sounds good!"));
        String text = ai.complete("Based on this conversation, suggest exactly 3 short reply options (each under 15 words). "
                + "Return ONLY a JSON array of 3 strings, nothing else:\n\n" + transcript, 150);
        List<String> suggestions = DEFAULT_SUGGESTIONS;
        Matcher m = JSON_ARRAY.matcher(text);
        if (m.find()) {
            try {
                suggestions = Arrays.stream(json.readValue(m.group(), String[].class)).limit(3).toList();
            } catch (RuntimeException ignored) {
                // keep defaults
            }
        }
        return Map.of("suggestions", suggestions);
    }

    @PostMapping("/tone")
    @Operation(summary = "Tone of a draft, with a gentler rewrite when harsh/frustrated")
    public ToneResult tone(@RequestBody(required = false) ToneRequest body) {
        throttle();
        String message = body == null || body.message() == null ? "" : body.message();
        if (message.length() < 5) return new ToneResult("neutral", null);
        String text = ai.complete("Analyze the emotional tone of this message and reply with ONLY a JSON object like "
                + "{\"tone\":\"neutral\",\"suggestion\":null}. Tone must be one of: neutral, positive, excited, frustrated, harsh, sad. "
                + "If the tone is harsh or frustrated, provide a gentler rewrite as \"suggestion\" (max 20 words), otherwise set "
                + "suggestion to null. Message: \"" + message.substring(0, Math.min(message.length(), 2000)) + "\"", 100);
        Matcher m = JSON_OBJECT.matcher(text);
        if (m.find()) {
            try {
                ToneResult r = json.readValue(m.group(), ToneResult.class);
                if (r != null && r.tone() != null) return r;
            } catch (RuntimeException ignored) {
                // keep defaults
            }
        }
        return new ToneResult("neutral", null);
    }

    /** Oldest-first "Name: text" lines of the last {@code limit} text messages; access is enforced by the chatroom module. */
    private String transcript(UUID roomId, UUID userId, int limit) {
        List<MessageView> page = messages.history(roomId, userId, null, limit).messages();
        return page.stream()
                .filter(v -> v.type() == Message.Type.text && v.message() != null && !v.message().isBlank())
                .map(v -> (v.name() == null ? "?" : v.name()) + ": " + v.message())
                .collect(Collectors.joining("\n"));
    }

    private UUID throttle() {
        UUID userId = CurrentUser.id();
        if (!rateLimiter.tryAcquire("rl:ai:" + userId, perMinute, perMinute / 60.0)) {
            throw ApiException.tooManyRequests("Too many AI requests, please slow down.");
        }
        return userId;
    }
}
