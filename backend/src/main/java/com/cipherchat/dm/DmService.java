package com.cipherchat.dm;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.domain.Limit;
import org.springframework.stereotype.Component;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.dm.DmDtos.ConversationView;
import com.cipherchat.dm.DmDtos.HistoryPage;
import com.cipherchat.dm.DmDtos.MessageView;
import com.cipherchat.dm.DmDtos.Preview;
import com.cipherchat.dm.DmDtos.SendRequest;
import com.cipherchat.dm.DmDtos.SendResult;
import com.cipherchat.dm.DmRepositories.Conversations;
import com.cipherchat.dm.DmRepositories.Messages;
import com.cipherchat.shared.api.ApiException;
import com.cipherchat.shared.events.MessagingEvents.DirectMessageSent;
import com.cipherchat.shared.infra.AppMetrics;
import com.cipherchat.shared.infra.RedisRateLimiter;
import com.cipherchat.user.UserService;
import com.cipherchat.user.UserView;

/**
 * Direct messages. Same exactly-once discipline as rooms (dedup on the
 * client id, unique-index backstops) plus the E2EE-specific replay guard:
 * one {@code (conversation, sender, sessionId, ctr)} slot, ever.
 *
 * <p>Sidebar previews are content-free by design: for E2EE rows the server
 * only knows "a message exists"; the client decrypts and caches its own
 * preview locally.
 */
@Service
public class DmService {

    private static final Logger log = LoggerFactory.getLogger(DmService.class);
    private static final int MAX_PAGE = 100;
    static final String ENCRYPTED_PLACEHOLDER = "🔒 Encrypted message";

    private final Conversations conversations;
    private final Messages messages;
    private final UserService users;
    private final Persistence persistence;
    private final RedisRateLimiter rateLimiter;
    private final AppMetrics metrics;
    private final int burst;
    private final double refillPerSecond;

    public DmService(Conversations conversations, Messages messages, UserService users, Persistence persistence,
                     RedisRateLimiter rateLimiter, AppMetrics metrics,
                     @org.springframework.beans.factory.annotation.Value("${cipherchat.rate-limit.messages-burst}") int burst,
                     @org.springframework.beans.factory.annotation.Value("${cipherchat.rate-limit.messages-refill-per-second}") double refillPerSecond) {
        this.conversations = conversations;
        this.messages = messages;
        this.users = users;
        this.persistence = persistence;
        this.rateLimiter = rateLimiter;
        this.metrics = metrics;
        this.burst = burst;
        this.refillPerSecond = refillPerSecond;
    }

    // ── conversations ────────────────────────────────────────────────────────

    public ConversationView start(UUID callerId, UUID targetId) {
        if (callerId.equals(targetId)) throw ApiException.badRequest("self_dm", "Cannot start a conversation with yourself.");
        UserView target = users.require(targetId);
        Conversation probe = Conversation.between(callerId, targetId);
        Conversation conv = conversations.findByUserLowAndUserHigh(probe.getUserLow(), probe.getUserHigh())
                .orElseGet(() -> {
                    try {
                        return persistence.create(probe);
                    } catch (DataIntegrityViolationException race) {
                        // Both sides clicked "start" at once — the unique pair index picked a winner.
                        return conversations.findByUserLowAndUserHigh(probe.getUserLow(), probe.getUserHigh()).orElseThrow();
                    }
                });
        return new ConversationView(conv.getId().toString(), new UserView.Summary(target.id(), target.name(), target.dp()),
                null, conv.getLastMessageAt());
    }

    @Transactional(readOnly = true)
    public List<ConversationView> list(UUID userId) {
        List<Conversation> convs = conversations.findAllFor(userId);
        if (convs.isEmpty()) return List.of();
        Map<UUID, UserView.Summary> people = users.summaries(convs.stream().map(c -> c.other(userId)).collect(Collectors.toSet()));
        Map<UUID, DmMessage> latest = messages.latestPerConversation(convs.stream().map(Conversation::getId).toList())
                .stream().collect(Collectors.toMap(DmMessage::getConversationId, m -> m));
        return convs.stream().map(c -> new ConversationView(
                c.getId().toString(), people.get(c.other(userId)),
                Optional.ofNullable(latest.get(c.getId())).map(DmService::preview).orElse(null),
                c.getLastMessageAt())).toList();
    }

    @Transactional(readOnly = true)
    public Conversation requireParticipant(UUID conversationId, UUID userId) {
        Conversation c = conversations.findById(conversationId)
                .orElseThrow(() -> ApiException.notFound("conversation_not_found", "Conversation not found."));
        if (!c.has(userId)) throw ApiException.forbidden("not_participant", "You are not part of this conversation.");
        return c;
    }

    // ── history ──────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public HistoryPage history(UUID conversationId, UUID userId, Long beforeId, int limit) {
        Conversation c = requireParticipant(conversationId, userId);
        int size = Math.min(Math.max(limit, 1), MAX_PAGE);
        List<DmMessage> rows = beforeId == null
                ? messages.findByConversationIdOrderByIdDesc(conversationId, Limit.of(size + 1))
                : messages.findByConversationIdAndIdLessThanOrderByIdDesc(conversationId, beforeId, Limit.of(size + 1));
        boolean hasMore = rows.size() > size;
        List<DmMessage> page = new ArrayList<>(rows.subList(0, Math.min(size, rows.size())));
        Collections.reverse(page);
        UserView.Summary other = users.summaries(List.of(c.other(userId))).get(c.other(userId));
        String next = hasMore && !page.isEmpty() ? String.valueOf(page.getFirst().getId()) : null;
        return new HistoryPage(views(page), other, new HistoryPage.Cursor(next, hasMore, size));
    }

    // ── send ─────────────────────────────────────────────────────────────────

    public SendResult send(UUID senderId, UUID conversationId, SendRequest req) {
        Conversation c = requireParticipant(conversationId, senderId);
        boolean hasText = req.message() != null && !req.message().isBlank();
        boolean hasEnvelope = req.envelope() != null;
        if (hasText == hasEnvelope) {
            throw ApiException.badRequest("invalid_message", "Exactly one of message or envelope is required.");
        }
        if (hasEnvelope) EnvelopeValidator.validate(req.envelope());

        if (!rateLimiter.tryAcquire("rl:msg:" + senderId, burst, refillPerSecond)) {
            metrics.rateLimited();
            throw ApiException.tooManyRequests("Slow down — you're sending too fast.");
        }

        UUID clientId = req.clientMessageId();
        if (clientId != null) {
            Optional<DmMessage> seen = messages.findByConversationIdAndClientMessageId(conversationId, clientId);
            if (seen.isPresent()) {
                metrics.duplicate();
                return result(seen.get(), true);
            }
        }

        DmMessage draft = hasEnvelope
                ? DmMessage.encrypted(conversationId, senderId, clientId, req.envelope())
                : DmMessage.plaintext(conversationId, senderId, clientId, req.message().trim());
        UserView sender = users.require(senderId);
        var sample = metrics.start();
        try {
            DmMessage saved = persistence.persist(draft, c, sender.name());
            metrics.sent();
            return result(saved, false);
        } catch (DataIntegrityViolationException e) {
            Optional<DmMessage> dup = clientId == null ? Optional.empty()
                    : messages.findByConversationIdAndClientMessageId(conversationId, clientId);
            if (dup.isPresent()) {
                metrics.duplicate();
                return result(dup.get(), true);
            }
            // Not a client retry → the (session, ctr) replay index fired: a replayed or forged counter.
            metrics.failed();
            log.warn("DM replay rejected conversationId={} sender={}", conversationId, senderId);
            throw ApiException.conflict("replayed_counter", "This message counter was already used.");
        } finally {
            metrics.stop(sample);
        }
    }

    // ── views ────────────────────────────────────────────────────────────────

    @Transactional(readOnly = true)
    public MessageView view(long messageId) {
        DmMessage m = messages.findById(messageId).orElseThrow(() -> ApiException.notFound("message_not_found", "Message not found."));
        return views(List.of(m)).getFirst();
    }

    List<MessageView> views(Collection<DmMessage> rows) {
        if (rows.isEmpty()) return List.of();
        Set<UUID> senders = rows.stream().map(DmMessage::getSenderId).collect(Collectors.toSet());
        Map<UUID, UserView.Summary> people = users.summaries(senders);
        return rows.stream().map(m -> new MessageView(
                String.valueOf(m.getId()), m.getType(),
                m.getType() == DmMessage.Type.PLAINTEXT_LEGACY ? m.getBody() : null,
                m.getType() == DmMessage.Type.E2EE_V1 ? m.getEnvelope() : null,
                m.getClientMessageId() == null ? null : m.getClientMessageId().toString(),
                m.isEdited(), m.getSenderId().toString(), people.get(m.getSenderId()), m.getCreatedAt())).toList();
    }

    static Preview preview(DmMessage m) {
        boolean enc = m.getType() == DmMessage.Type.E2EE_V1;
        return new Preview(enc ? ENCRYPTED_PLACEHOLDER : m.getBody(), enc, m.getCreatedAt());
    }

    private SendResult result(DmMessage m, boolean duplicate) {
        return new SendResult(true, String.valueOf(m.getId()), duplicate, views(List.of(m)).getFirst());
    }

    /** REQUIRES_NEW so a unique-index violation can be interpreted after rollback (see MessagePersistence). */
    @Component
    static class Persistence {
        private final Conversations conversations;
        private final Messages messages;
        private final ApplicationEventPublisher events;

        Persistence(Conversations conversations, Messages messages, ApplicationEventPublisher events) {
            this.conversations = conversations;
            this.messages = messages;
            this.events = events;
        }

        @Transactional(propagation = Propagation.REQUIRES_NEW)
        Conversation create(Conversation c) {
            return conversations.save(c);
        }

        @Transactional(propagation = Propagation.REQUIRES_NEW)
        DmMessage persist(DmMessage draft, Conversation c, String senderName) {
            DmMessage saved = messages.save(draft);
            Conversation managed = conversations.findById(c.getId()).orElse(c);
            managed.touch(Instant.now());
            events.publishEvent(new DirectMessageSent(UUID.randomUUID(), Instant.now(), c.getId(), saved.getId(),
                    saved.getSenderId(), senderName, c.other(saved.getSenderId()), saved.getType() == DmMessage.Type.E2EE_V1));
            return saved;
        }
    }
}
