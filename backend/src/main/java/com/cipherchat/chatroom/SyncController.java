package com.cipherchat.chatroom;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.cipherchat.chatroom.ChatroomDtos.RoomDelta;
import com.cipherchat.chatroom.ChatroomDtos.SyncRequest;
import com.cipherchat.chatroom.ChatroomDtos.SyncResponse;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.security.CurrentUser;

import io.micrometer.core.instrument.DistributionSummary;
import io.micrometer.core.instrument.MeterRegistry;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;

/**
 * Delta sync for reconnecting clients: "here is the last sequence I hold per room — give me only
 * what came after". One round trip replaces a history fetch per room, the rows are a compact
 * projection (no reactions/receipts; those arrive live), and the response is content-negotiated:
 * {@code Accept: application/cbor} returns the same structure in CBOR, which is what clients on
 * poor links ask for. JSON stays available for every other client and for the verification scripts.
 */
@RestController
@RequestMapping("/api/v1/sync")
@Tag(name = "Sync", description = "Sequence-based delta sync (JSON or CBOR)")
public class SyncController {

    static final int MAX_ROOMS = 100;
    static final int DEFAULT_PER_ROOM = 200;
    static final int MAX_PER_ROOM = 500;

    private final MessageService messages;
    private final MeterRegistry meters;
    private final DistributionSummary gapSize;

    public SyncController(MessageService messages, MeterRegistry meters) {
        this.messages = messages;
        this.meters = meters;
        this.gapSize = DistributionSummary.builder("cipherchat.sync.gap.messages")
                .description("Messages returned per room by a delta sync (how far behind reconnecting clients are)")
                .register(meters);
    }

    @PostMapping(path = "/rooms", produces = {MediaType.APPLICATION_JSON_VALUE, MediaType.APPLICATION_CBOR_VALUE})
    @Operation(summary = "Messages after the caller's last-seen sequence, per room; rooms the caller cannot read are reported as denied")
    public SyncResponse rooms(@RequestBody SyncRequest body,
                              @RequestHeader(name = "Accept", required = false) String accept) {
        if (body == null || body.rooms() == null || body.rooms().isEmpty()) {
            throw ApiException.badRequest("invalid_sync", "At least one room cursor is required.");
        }
        if (body.rooms().size() > MAX_ROOMS) {
            throw ApiException.badRequest("invalid_sync", "At most " + MAX_ROOMS + " rooms per sync.");
        }
        int perRoom = body.maxPerRoom() == null ? DEFAULT_PER_ROOM : Math.min(Math.max(body.maxPerRoom(), 1), MAX_PER_ROOM);
        UUID userId = CurrentUser.id();

        Map<UUID, Long> cursors = new LinkedHashMap<>();
        body.rooms().forEach((room, after) -> cursors.put(room, after == null || after < 0 ? 0L : after));
        List<RoomDelta> deltas = messages.deltas(userId, cursors, perRoom);

        deltas.forEach(d -> gapSize.record(d.messages().size()));
        meters.counter("cipherchat.sync.requests", "format",
                accept != null && accept.contains(MediaType.APPLICATION_CBOR_VALUE) ? "cbor" : "json").increment();
        return new SyncResponse(deltas);
    }
}
