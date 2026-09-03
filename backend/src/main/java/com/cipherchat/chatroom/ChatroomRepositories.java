package com.cipherchat.chatroom;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Repositories for the chatroom module, grouped in one file because they are
 * package-private implementation detail: only {@link ChatroomService} and
 * {@link MessageService} touch them.
 */
final class ChatroomRepositories {

    private ChatroomRepositories() {
    }

    interface Chatrooms extends JpaRepository<Chatroom, UUID> {

        @Query("select c from Chatroom c where lower(c.name) = lower(:name)")
        Optional<Chatroom> findByNameIgnoringCase(@Param("name") String name);

        /** Public rooms + private rooms the user belongs to, newest first. */
        @Query("""
                select c from Chatroom c
                where c.privateRoom = false
                   or exists (select 1 from ChatroomMember m where m.key.chatroomId = c.id and m.key.userId = :userId)
                order by c.createdAt desc""")
        List<Chatroom> findVisibleTo(@Param("userId") UUID userId);
    }

    interface Members extends JpaRepository<ChatroomMember, ChatroomMember.Key> {

        List<ChatroomMember> findAllByKeyChatroomId(UUID chatroomId);

        Optional<ChatroomMember> findByKeyChatroomIdAndKeyUserId(UUID chatroomId, UUID userId);

        long countByKeyChatroomId(UUID chatroomId);

        @Query("select m.key.chatroomId, count(m) from ChatroomMember m where m.key.chatroomId in :ids group by m.key.chatroomId")
        List<Object[]> countByRooms(@Param("ids") Collection<UUID> ids);

        List<ChatroomMember> findAllByKeyUserIdAndKeyChatroomIdIn(UUID userId, Collection<UUID> chatroomIds);

        @Modifying
        @Query("delete from ChatroomMember m where m.key.chatroomId = :room and m.key.userId = :user")
        int remove(@Param("room") UUID chatroomId, @Param("user") UUID userId);

        @Modifying
        @Query("update ChatroomMember m set m.role = :role where m.key.chatroomId = :room and m.key.userId = :user")
        int setRole(@Param("room") UUID chatroomId, @Param("user") UUID userId, @Param("role") ChatroomMember.Role role);
    }

    interface Messages extends JpaRepository<Message, Long> {

        /** Cursor page: the N messages older than {@code beforeSeq}, newest first — an index seek, not a scan. */
        List<Message> findByChatroomIdAndSequenceNumberLessThanOrderBySequenceNumberDesc(UUID chatroomId, long beforeSeq, Limit limit);

        List<Message> findByChatroomIdOrderBySequenceNumberDesc(UUID chatroomId, Limit limit);

        @Query("select coalesce(max(m.sequenceNumber), 0) from Message m where m.chatroomId = :room")
        long maxSequence(@Param("room") UUID chatroomId);

        Optional<Message> findByClientMessageId(UUID clientMessageId);

        long countByChatroomIdAndSequenceNumberGreaterThanAndSenderIdNot(UUID chatroomId, long watermark, UUID senderId);

        List<Message> findTop10ByChatroomIdAndPinnedTrueOrderByCreatedAtDesc(UUID chatroomId);

        /** Ranked full-text search on the GIN index; stemmed, whole-word (like Mongo's $text). */
        @Query(value = """
                select * from messages
                where chatroom_id = :room and to_tsvector('english', body) @@ plainto_tsquery('english', :q)
                order by ts_rank(to_tsvector('english', body), plainto_tsquery('english', :q)) desc, created_at desc
                limit 50""", nativeQuery = true)
        List<Message> searchFullText(@Param("room") UUID chatroomId, @Param("q") String query);

        /** Fallback for partial words / symbols the text parser drops. Bound parameter — no injection, no ReDoS. */
        @Query(value = "select * from messages where chatroom_id = :room and body ilike :pattern order by created_at desc limit 50",
                nativeQuery = true)
        List<Message> searchSubstring(@Param("room") UUID chatroomId, @Param("pattern") String pattern);

        @Modifying
        @Query("delete from Message m where m.expiresAt is not null and m.expiresAt < :now")
        int deleteExpired(@Param("now") Instant now);
    }

    interface Reactions extends JpaRepository<MessageReaction, MessageReaction.Key> {
        List<MessageReaction> findAllByKeyMessageId(Long messageId);
        List<MessageReaction> findAllByKeyMessageIdIn(Collection<Long> messageIds);
    }

    interface Statuses extends JpaRepository<MessageStatus, MessageStatus.Key> {

        List<MessageStatus> findAllByKeyMessageIdIn(Collection<Long> messageIds);

        @Modifying
        @Query(value = """
                insert into message_status (message_id, user_id, delivered_at) values (:msg, :user, now())
                on conflict (message_id, user_id) do update set delivered_at = coalesce(message_status.delivered_at, excluded.delivered_at)""",
                nativeQuery = true)
        int markDelivered(@Param("msg") long messageId, @Param("user") UUID userId);

        /** Read receipts for every message in the room up to a sequence, except the reader's own. */
        @Modifying
        @Query(value = """
                insert into message_status (message_id, user_id, delivered_at, read_at)
                select m.id, :user, now(), now() from messages m
                where m.chatroom_id = :room and m.sender_id <> :user and m.sequence_number <= :upTo
                on conflict (message_id, user_id) do update
                    set read_at = coalesce(message_status.read_at, excluded.read_at),
                        delivered_at = coalesce(message_status.delivered_at, excluded.delivered_at)""",
                nativeQuery = true)
        int markReadUpTo(@Param("room") UUID chatroomId, @Param("user") UUID userId, @Param("upTo") long upToSequence);
    }

    interface ReadStates extends JpaRepository<RoomReadState, RoomReadState.Key> {

        List<RoomReadState> findAllByKeyUserId(UUID userId);

        /** Advance-only watermark as one upsert: never moves backwards, never races. */
        @Modifying
        @Query(value = """
                insert into room_read_state (user_id, chatroom_id, last_read_sequence, updated_at)
                values (:user, :room, :seq, now())
                on conflict (user_id, chatroom_id) do update
                    set last_read_sequence = greatest(room_read_state.last_read_sequence, excluded.last_read_sequence),
                        updated_at = now()""",
                nativeQuery = true)
        int advance(@Param("user") UUID userId, @Param("room") UUID chatroomId, @Param("seq") long sequence);
    }
}
