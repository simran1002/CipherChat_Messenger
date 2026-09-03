package com.cipherchat.chatroom;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Limit;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.chatroom.ChatroomDtos.CursorPage;
import com.cipherchat.chatroom.ChatroomDtos.MessageView;
import com.cipherchat.chatroom.ChatroomDtos.ReactionView;
import com.cipherchat.chatroom.ChatroomDtos.ReceiptView;
import com.cipherchat.chatroom.ChatroomDtos.ReplyRef;
import com.cipherchat.chatroom.ChatroomDtos.RoomSummary;
import com.cipherchat.chatroom.ChatroomDtos.SendFileMessageRequest;
import com.cipherchat.chatroom.ChatroomDtos.SendMessageRequest;
import com.cipherchat.chatroom.ChatroomDtos.SendResult;
import com.cipherchat.chatroom.ChatroomRepositories.Messages;
import com.cipherchat.chatroom.ChatroomRepositories.Reactions;
import com.cipherchat.chatroom.ChatroomRepositories.ReadStates;
import com.cipherchat.chatroom.ChatroomRepositories.Statuses;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.events.MessagingEvents.MessageDeleted;
import com.cipherchat.shared.events.MessagingEvents.MessageDelivered;
import com.cipherchat.shared.events.MessagingEvents.MessageEdited;
import com.cipherchat.shared.events.MessagingEvents.MessagePinned;
import com.cipherchat.shared.events.MessagingEvents.MessageRead;
import com.cipherchat.shared.events.MessagingEvents.ReactionUpdated;
import com.cipherchat.shared.infra.AppMetrics;
import com.cipherchat.shared.infra.RedisDeduplicator;
import com.cipherchat.shared.infra.RedisRateLimiter;
import com.cipherchat.shared.infra.RedisSequenceCounter;
import com.cipherchat.user.UserService;
import com.cipherchat.user.UserView;

/**
 * Exactly-once persistence over at-least-once transport.
 *
 * <pre>
 *   rate limit (Redis Lua bucket)
 *     → dedup (Redis SET NX on the client's UUID; DB unique index as backstop)
 *       → sequence (Redis INCR seeded from the DB high-water mark)
 *         → persist + publish MessageSent in one transaction (outbox)
 * </pre>
 *
 * A retry of the same client UUID — lost ACK, reconnect, offline-queue drain
 * — returns the original row with {@code duplicate=true}. Two replicas racing
 * the same UUID inside the same instant both pass the Redis check; the loser
 * hits the unique index, and {@link #send} converts that violation into the
 * same duplicate answer. Nothing is ever persisted twice.
 */
@Service
public class MessageService {

    private static final Logger log = LoggerFactory.getLogger(MessageService.class);
    private static final int MAX_PAGE = 100;

    private final Messages messages;
    private final Reactions reactions;
    private final Statuses statuses;
    private final ReadStates readStates;
    private final ChatroomService rooms;
    private final UserService users;
    private final MessagePersistence persistence;
    private final RedisRateLimiter rateLimiter;
    private final RedisDeduplicator dedup;
    private final RedisSequenceCounter sequences;
    private final ApplicationEventPublisher events;
    private final AppMetrics metrics;
    private final int burst;
    private final double refillPerSecond;

    public MessageService(Messages messages, Reactions reactions, Statuses statuses, ReadStates readStates,
                          ChatroomService rooms, UserService users, MessagePersistence persistence,
                          RedisRateLimiter rateLimiter, RedisDeduplicator dedup, RedisSequenceCounter sequences,
                          ApplicationEventPublisher events, AppMetrics metrics,
                          @org.springframework.beans.factory.annotation.Value("${cipherchat.rate-limit.messages-burst}") int burst,
                          @org.springframework.beans.factory.annotation.Value("${cipherchat.rate-limit.messages-refill-per-second}") double refillPerSecond) {
        this.messages = messages;
        this.reactions = reactions;
        this.statuses = statuses;
        this.readStates = readStates;
        this.rooms = rooms;
        this.users = users;
        this.persistence = persistence;
        this.rateLimiter = rateLimiter;
        this.dedup = dedup;
        this.sequences = sequences;
        this.events = events;
        this.metrics = metrics;
        this.burst = burst;
        this.refillPerSecond = refillPerSecond;
    }

    // ── send ─────────────────────────────────────────────────────────────────

    public SendResult send(UUID senderId, UUID roomId, SendMessageRequest req) {
        Message draft = new Message(roomId, senderId, Message.Type.text, req.message().trim(), 0, req.clientMessageId());
        if (req.replyTo() != null) draft.replyTo(req.replyTo().messageId(), req.replyTo().preview(), req.replyTo().senderName());
        if (req.expiresIn() != null) draft.expireAt(Instant.now().plusSeconds(req.expiresIn()));
        if (req.mentions() != null && !req.mentions().isEmpty()) draft.mention(req.mentions().toArray(UUID[]::new));
        return sendDraft(senderId, roomId, draft);
    }

    public SendResult sendFile(UUID senderId, UUID roomId, SendFileMessageRequest req) {
        if (req.type() == Message.Type.text) throw ApiException.badRequest("invalid_message", "Use the text endpoint for text.");
        Message draft = new Message(roomId, senderId, req.type(), req.message(), 0, req.clientMessageId());
        draft.attachFile(req.fileUrl(), req.fileName(), req.mimeType(), req.fileSize());
        draft.locate(req.lat(), req.lng());
        if (req.replyTo() != null) draft.replyTo(req.replyTo().messageId(), req.replyTo().preview(), req.replyTo().senderName());
        return sendDraft(senderId, roomId, draft);
    }

    private SendResult sendDraft(UUID senderId, UUID roomId, Message draft) {
        rooms.assertAccess(roomId, senderId);

        if (!rateLimiter.tryAcquire("rl:msg:" + senderId, burst, refillPerSecond)) {
            metrics.rateLimited();
            throw ApiException.tooManyRequests("Slow down — you're sending too fast.");
        }

        UUID clientId = draft.getClientMessageId();
        if (clientId != null) {
            Optional<Message> seen = dedup.lookup(clientId).flatMap(messages::findById)
                    .or(() -> messages.findByClientMessageId(clientId));
            if (seen.isPresent()) {
                metrics.duplicate();
                return result(seen.get(), true);
            }
        }

        UserView sender = users.require(senderId);
        var sample = metrics.start();
        long seq = sequences.next(roomId, () -> messages.maxSequence(roomId));
        Message toSave = withSequence(draft, seq);

        Message saved;
        try {
            saved = persistence.persist(toSave, sender.name());
        } catch (DataIntegrityViolationException e) {
            // The DB backstop caught a race the Redis layer missed: same client id (or, if the
            // counter was ever wrong, same sequence slot). Resolve to the existing row.
            Optional<Message> existing = clientId == null ? Optional.empty() : messages.findByClientMessageId(clientId);
            if (existing.isPresent()) {
                metrics.duplicate();
                metrics.stop(sample);
                log.info("Duplicate absorbed by unique index roomId={} clientId={}", roomId, clientId);
                return result(existing.get(), true);
            }
            metrics.failed();
            metrics.stop(sample);
            log.error("Sequence slot collision roomId={} seq={} — counter drifted from DB", roomId, seq, e);
            throw new IllegalStateException("Could not persist message", e);
        }
        metrics.sent();
        metrics.stop(sample);
        if (clientId != null) dedup.mark(clientId, saved.getId());
        rooms.ensureMembership(roomId, senderId);       // public rooms: first message = participation
        return result(saved, false);
    }

    private static Message withSequence(Message draft, long seq) {
        Message m = new Message(draft.getChatroomId(), draft.getSenderId(), draft.getType(), draft.getBody(), seq, draft.getClientMessageId());
        m.attachFile(draft.getFileUrl(), draft.getFileName(), draft.getMimeType(), draft.getFileSize());
        m.locate(draft.getLat(), draft.getLng());
        m.replyTo(draft.getReplyToId(), draft.getReplyPreview(), draft.getReplySenderName());
        m.mention(draft.getMentions());
        m.expireAt(draft.getExpiresAt());
        return m;
    }

    // ── history ──────────────────────────────────────────────────────────────

    /** Cursor pagination on the per-room sequence: an indexed seek regardless of history depth. */
    @Transactional(readOnly = true)
    public CursorPage history(UUID roomId, UUID userId, Long beforeSequence, int limit) {
        Chatroom room = rooms.assertAccess(roomId, userId);
        int size = Math.min(Math.max(limit, 1), MAX_PAGE);
        List<Message> rows = beforeSequence == null
                ? messages.findByChatroomIdOrderBySequenceNumberDesc(roomId, Limit.of(size + 1))
                : messages.findByChatroomIdAndSequenceNumberLessThanOrderBySequenceNumberDesc(roomId, beforeSequence, Limit.of(size + 1));
        boolean hasMore = rows.size() > size;
        List<Message> page = new ArrayList<>(rows.subList(0, Math.min(size, rows.size())));
        java.util.Collections.reverse(page);                    // ascending for rendering
        String next = hasMore && !page.isEmpty() ? String.valueOf(page.getFirst().getSequenceNumber()) : null;
        return new CursorPage(views(page), new RoomSummary(room.getId().toString(), room.getName(), room.isPrivateRoom()),
                new CursorPage.Cursor(next, hasMore, size));
    }

    @Transactional(readOnly = true)
    public List<MessageView> pinned(UUID roomId, UUID userId) {
        rooms.assertAccess(roomId, userId);
        return views(messages.findTop10ByChatroomIdAndPinnedTrueOrderByCreatedAtDesc(roomId));
    }

    @Transactional(readOnly = true)
    public List<MessageView> search(UUID roomId, UUID userId, String query) {
        rooms.assertAccess(roomId, userId);
        String term = query == null ? "" : query.trim();
        if (term.isEmpty()) throw ApiException.badRequest("Search query is required.");
        List<Message> hits = messages.searchFullText(roomId, term);
        if (hits.isEmpty()) {
            String escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
            hits = messages.searchSubstring(roomId, "%" + escaped + "%");
        }
        return views(hits);
    }

    // ── mutations ────────────────────────────────────────────────────────────

    @Transactional
    public MessageView edit(long messageId, UUID userId, String newBody) {
        Message m = own(messageId, userId, "edit");
        m.edit(newBody.trim());
        events.publishEvent(new MessageEdited(UUID.randomUUID(), Instant.now(), m.getChatroomId(), messageId, m.getBody()));
        return view(m);
    }

    @Transactional
    public void delete(long messageId, UUID userId) {
        Message m = own(messageId, userId, "delete");
        messages.delete(m);
        events.publishEvent(new MessageDeleted(UUID.randomUUID(), Instant.now(), m.getChatroomId(), messageId));
        log.info("Message deleted messageId={} by={}", messageId, userId);
    }

    @Transactional
    public boolean togglePin(long messageId, UUID userId) {
        Message m = load(messageId);
        rooms.assertAccess(m.getChatroomId(), userId);
        m.togglePin();
        events.publishEvent(new MessagePinned(UUID.randomUUID(), Instant.now(), m.getChatroomId(), messageId, m.isPinned()));
        return m.isPinned();
    }

    @Transactional
    public List<ReactionView> toggleReaction(long messageId, UUID userId, String emoji) {
        Message m = load(messageId);
        rooms.assertAccess(m.getChatroomId(), userId);
        MessageReaction.Key key = new MessageReaction.Key(messageId, userId, emoji);
        if (reactions.existsById(key)) {
            reactions.deleteById(key);
        } else {
            reactions.save(new MessageReaction(messageId, userId, emoji));
        }
        events.publishEvent(new ReactionUpdated(UUID.randomUUID(), Instant.now(), m.getChatroomId(), messageId));
        return reactionViews(reactions.findAllByKeyMessageId(messageId));
    }

    @Transactional(readOnly = true)
    public List<ReactionView> reactionsOf(long messageId) {
        return reactionViews(reactions.findAllByKeyMessageId(messageId));
    }

    /** Read receipts up to a sequence (default: latest) + advance the unread watermark. */
    @Transactional
    public int markRead(UUID roomId, UUID userId, Long upToSequence) {
        rooms.assertAccess(roomId, userId);
        long upTo = upToSequence != null ? upToSequence : messages.maxSequence(roomId);
        int marked = statuses.markReadUpTo(roomId, userId, upTo);
        readStates.advance(userId, roomId, upTo);
        events.publishEvent(new MessageRead(UUID.randomUUID(), Instant.now(), roomId, userId, upTo));
        return marked;
    }

    @Transactional
    public void markDelivered(long messageId, UUID userId) {
        Message m = load(messageId);
        statuses.markDelivered(messageId, userId);
        events.publishEvent(new MessageDelivered(UUID.randomUUID(), Instant.now(), m.getChatroomId(), messageId, userId));
    }

    /** Self-destruct messages: Postgres has no TTL index, so sweep every minute. */
    @Scheduled(fixedDelayString = "PT1M", initialDelayString = "PT1M")
    @Transactional
    public void sweepExpired() {
        int n = messages.deleteExpired(Instant.now());
        if (n > 0) log.info("Swept {} expired messages", n);
    }

    // ── views ────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public MessageView view(long messageId) {
        return view(load(messageId));
    }

    MessageView view(Message m) {
        return views(List.of(m)).getFirst();
    }

    /** Batch enrichment: senders, reactions and receipts each fetched once per page. */
    List<MessageView> views(Collection<Message> rows) {
        if (rows.isEmpty()) return List.of();
        List<Long> ids = rows.stream().map(Message::getId).toList();
        Map<UUID, UserView.Summary> people = users.summaries(rows.stream().map(Message::getSenderId).collect(Collectors.toSet()));
        Map<Long, List<MessageReaction>> reacts = reactions.findAllByKeyMessageIdIn(ids).stream()
                .collect(Collectors.groupingBy(MessageReaction::getMessageId));
        Map<Long, List<MessageStatus>> stats = statuses.findAllByKeyMessageIdIn(ids).stream()
                .collect(Collectors.groupingBy(MessageStatus::getMessageId));
        // Reactor names for the reaction chips
        Map<UUID, UserView.Summary> reactors = users.summaries(reacts.values().stream().flatMap(List::stream)
                .map(MessageReaction::getUserId).collect(Collectors.toSet()));

        return rows.stream().map(m -> {
            UserView.Summary sender = people.get(m.getSenderId());
            List<MessageStatus> st = stats.getOrDefault(m.getId(), List.of());
            return new MessageView(
                    String.valueOf(m.getId()), m.getChatroomId().toString(), m.getType(), m.getBody(),
                    m.getSenderId().toString(), sender == null ? "" : sender.name(), sender == null ? "" : sender.dp(),
                    m.getFileUrl(), m.getFileName(), m.getMimeType(), m.getFileSize(), m.getLat(), m.getLng(),
                    m.getReplyToId() == null ? null : new ReplyRef(m.getReplyToId(), m.getReplyPreview(), m.getReplySenderName()),
                    Arrays.stream(m.getMentions()).map(UUID::toString).toList(),
                    reactionViews(reacts.getOrDefault(m.getId(), List.of()), reactors),
                    st.stream().filter(s -> s.getReadAt() != null).map(s -> new ReceiptView(s.getUserId().toString(), s.getReadAt())).toList(),
                    st.stream().filter(s -> s.getDeliveredAt() != null).map(s -> s.getUserId().toString()).toList(),
                    m.isPinned(), m.isEdited(), m.getExpiresAt(), m.getSequenceNumber(),
                    m.getClientMessageId() == null ? null : m.getClientMessageId().toString(),
                    "sent", m.getCreatedAt());
        }).toList();
    }

    private List<ReactionView> reactionViews(List<MessageReaction> rs) {
        return reactionViews(rs, users.summaries(rs.stream().map(MessageReaction::getUserId).collect(Collectors.toSet())));
    }

    private static List<ReactionView> reactionViews(List<MessageReaction> rs, Map<UUID, UserView.Summary> names) {
        return rs.stream().map(r -> new ReactionView(r.getEmoji(), r.getUserId().toString(),
                Optional.ofNullable(names.get(r.getUserId())).map(UserView.Summary::name).orElse(""))).toList();
    }

    private SendResult result(Message m, boolean duplicate) {
        return new SendResult(true, String.valueOf(m.getId()), m.getSequenceNumber(), duplicate, view(m));
    }

    private Message load(long id) {
        return messages.findById(id).orElseThrow(() -> ApiException.notFound("message_not_found", "Message not found."));
    }

    private Message own(long id, UUID userId, String verb) {
        Message m = load(id);
        if (!m.getSenderId().equals(userId)) {
            throw ApiException.forbidden("not_owner", "You can only " + verb + " your own messages.");
        }
        return m;
    }
}
