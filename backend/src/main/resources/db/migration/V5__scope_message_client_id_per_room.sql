-- The idempotency key for a room message was unique across the WHOLE table, not per room — the DM table
-- already scopes its own equivalent index to (conversation_id, client_message_id); this one never
-- matched that pattern. Two consequences: a client id colliding with one used in any other room, ever,
-- made the INSERT fail outright, and the application-level dedup lookup it backstops answered "duplicate"
-- with whatever row holds that id — another room's message — regardless of the caller's membership there.
DROP INDEX messages_client_id_uq;

CREATE UNIQUE INDEX messages_chatroom_client_id_uq ON messages (chatroom_id, client_message_id)
    WHERE client_message_id IS NOT NULL;
