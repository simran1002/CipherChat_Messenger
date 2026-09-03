package com.cipherchat.dm;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

final class DmRepositories {

    private DmRepositories() {
    }

    interface Conversations extends JpaRepository<Conversation, UUID> {

        Optional<Conversation> findByUserLowAndUserHigh(UUID userLow, UUID userHigh);

        @Query("select c from Conversation c where c.userLow = :u or c.userHigh = :u order by c.lastMessageAt desc")
        List<Conversation> findAllFor(@Param("u") UUID userId);
    }

    interface Messages extends JpaRepository<DmMessage, Long> {

        List<DmMessage> findByConversationIdOrderByIdDesc(UUID conversationId, Limit limit);

        List<DmMessage> findByConversationIdAndIdLessThanOrderByIdDesc(UUID conversationId, long beforeId, Limit limit);

        Optional<DmMessage> findByConversationIdAndClientMessageId(UUID conversationId, UUID clientMessageId);

        long countByConversationId(UUID conversationId);

        /** Latest message per conversation in ONE query (sidebar previews) — DISTINCT ON walks the (conv, id desc) index. */
        @Query(value = """
                select distinct on (conversation_id) * from dm_messages
                where conversation_id in (:ids)
                order by conversation_id, id desc""", nativeQuery = true)
        List<DmMessage> latestPerConversation(@Param("ids") Collection<UUID> ids);
    }
}
