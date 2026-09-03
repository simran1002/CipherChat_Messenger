package com.cipherchat.chatroom;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import com.cipherchat.chatroom.ChatroomRepositories.Messages;
import com.cipherchat.chatroom.ChatroomRepositories.ReadStates;
import com.cipherchat.shared.events.MessagingEvents.MessageSent;

/**
 * The transactional core of a send, isolated in its own bean so that
 * {@link MessageService} can catch a unique-constraint violation from the
 * database backstop <em>after</em> this transaction has rolled back and treat
 * it as the duplicate it is. (Catching inside the same transaction would leave
 * it marked rollback-only and poison every later statement.)
 *
 * <p>The {@link MessageSent} event is published inside this transaction:
 * Spring Modulith writes it to the event-publication table in the same
 * commit, then externalizes it to Kafka. If the process dies between commit
 * and publish, the outstanding publication is replayed on restart — the
 * message and its event are atomic.
 */
@Component
class MessagePersistence {

    private final Messages messages;
    private final ReadStates readStates;
    private final ApplicationEventPublisher events;

    MessagePersistence(Messages messages, ReadStates readStates, ApplicationEventPublisher events) {
        this.messages = messages;
        this.readStates = readStates;
        this.events = events;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    Message persist(Message draft, String senderName) {
        Message saved = messages.save(draft);
        // The sender has, by definition, read their own message.
        readStates.advance(saved.getSenderId(), saved.getChatroomId(), saved.getSequenceNumber());
        events.publishEvent(new MessageSent(
                UUID.randomUUID(), Instant.now(),
                saved.getChatroomId(), saved.getId(), saved.getSequenceNumber(),
                saved.getSenderId(), senderName,
                preview(saved), List.of(saved.getMentions())));
        return saved;
    }

    static String preview(Message m) {
        return switch (m.getType()) {
            case text -> m.getBody().length() > 120 ? m.getBody().substring(0, 120) + "…" : m.getBody();
            case image -> "📷 Photo";
            case audio -> "🎤 Voice message";
            case file -> "📎 " + (m.getFileName() == null ? "File" : m.getFileName());
            case location -> "📍 Location";
        };
    }
}
