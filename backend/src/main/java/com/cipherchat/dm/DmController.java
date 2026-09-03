package com.cipherchat.dm;

import java.util.List;
import java.util.UUID;

import jakarta.validation.Valid;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.dm.DmDtos.ConversationView;
import com.cipherchat.dm.DmDtos.HistoryPage;
import com.cipherchat.dm.DmDtos.SendRequest;
import com.cipherchat.dm.DmDtos.SendResult;
import com.cipherchat.dm.DmDtos.StartRequest;
import com.cipherchat.shared.security.CurrentUser;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

@RestController
@RequestMapping("/api/v1/conversations")
@Tag(name = "Direct messages", description = "Two-party E2EE conversations")
public class DmController {

    private final DmService dms;

    public DmController(DmService dms) {
        this.dms = dms;
    }

    @GetMapping
    @Operation(summary = "The caller's conversations with content-free previews")
    public List<ConversationView> list() {
        return dms.list(CurrentUser.id());
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Get or create the conversation with another user")
    public ConversationView start(@Valid @RequestBody StartRequest body) {
        return dms.start(CurrentUser.id(), body.targetUserId());
    }

    @GetMapping("/{conversationId}/messages")
    @Operation(summary = "History, cursor-paginated (?before=<messageId>&limit=50)")
    public HistoryPage history(@PathVariable UUID conversationId,
                               @RequestParam(required = false) Long before,
                               @RequestParam(defaultValue = "50") int limit) {
        return dms.history(conversationId, CurrentUser.id(), before, limit);
    }

    @PostMapping("/{conversationId}/messages")
    @ResponseStatus(HttpStatus.CREATED)
    @Operation(summary = "Send an E2EE envelope (or legacy plaintext); idempotent on clientMessageId")
    public SendResult send(@PathVariable UUID conversationId, @Valid @RequestBody SendRequest body) {
        return dms.send(CurrentUser.id(), conversationId, body);
    }
}
