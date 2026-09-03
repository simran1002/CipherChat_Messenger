-- CipherChat — initial PostgreSQL schema.
--
-- Conventions
--   * UUID primary keys for entities that appear in URLs (users, rooms,
--     conversations): unguessable, safe to expose, mergeable across nodes.
--   * BIGINT IDENTITY for the two high-volume append-only tables (messages,
--     dm_messages): half the index size of UUIDs, naturally time-ordered, and
--     the id doubles as an opaque pagination cursor.
--   * Every timestamp is TIMESTAMPTZ. Every FK is indexed on the child side.
--   * Delivery-guarantee backstops live HERE, not only in Redis: even if
--     every dedup / sequence layer above fails, the same idempotency key or
--     sequence slot can never be persisted twice.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ── Users & auth ─────────────────────────────────────────────────────────────

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(50)  NOT NULL,
    email           VARCHAR(254) NOT NULL,
    password_hash   VARCHAR(100) NOT NULL,                 -- BCrypt, never plaintext
    role            VARCHAR(16)  NOT NULL DEFAULT 'USER'
                    CHECK (role IN ('USER', 'ADMIN')),
    dp              TEXT         NOT NULL DEFAULT '',
    bio             VARCHAR(160) NOT NULL DEFAULT '',
    presence_status VARCHAR(20)  NOT NULL DEFAULT 'available'
                    CHECK (presence_status IN ('available','coding','in_meeting','focusing','driving','away','busy')),
    presence_note   VARCHAR(80)  NOT NULL DEFAULT '',
    is_online       BOOLEAN      NOT NULL DEFAULT FALSE,
    last_seen       TIMESTAMPTZ,
    version         BIGINT       NOT NULL DEFAULT 0,       -- optimistic locking
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness without the citext extension.
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));

-- One row per live session. The raw refresh token only ever lives in an
-- httpOnly cookie; the SHA-256 hash is stored so a database dump cannot be
-- replayed as a session. Rotation deletes the used row — presenting a deleted
-- token again is the theft signal.
CREATE TABLE refresh_tokens (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    CHAR(64)    NOT NULL UNIQUE,
    expires_at    TIMESTAMPTZ NOT NULL,
    created_by_ip VARCHAR(45) NOT NULL DEFAULT '',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx    ON refresh_tokens (user_id, created_at DESC);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);   -- sweep job

-- TOTP second factor. The seed is AES-256-GCM sealed under a key derived from
-- the server secret (a DB dump alone can't mint codes); backup codes are
-- BCrypt hashes, removed as consumed.
CREATE TABLE two_factor (
    user_id       UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    secret_sealed TEXT        NOT NULL,
    backup_codes  TEXT[]      NOT NULL DEFAULT '{}',
    enabled_at    TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── E2EE key directory (server stores public material + opaque blobs only) ──

CREATE TABLE user_keys (
    user_id           UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    identity_ed25519  TEXT        NOT NULL,
    identity_x25519   TEXT        NOT NULL,
    spk_key_id        INTEGER     NOT NULL,
    spk_pub_x25519    TEXT        NOT NULL,
    spk_sig           TEXT        NOT NULL,   -- Ed25519 over spk_pub, verified on publish
    key_version       INTEGER     NOT NULL DEFAULT 1,
    published_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE key_backups (
    user_id    UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    blob       TEXT        NOT NULL CHECK (length(blob) <= 131072),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Rooms ────────────────────────────────────────────────────────────────────

CREATE TABLE chatrooms (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(50) NOT NULL,
    is_private BOOLEAN     NOT NULL DEFAULT FALSE,
    created_by UUID        REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX chatrooms_name_lower_uq ON chatrooms (lower(name));

-- Public rooms: membership is a participation record. Private rooms:
-- membership IS the access control.
CREATE TABLE chatroom_members (
    chatroom_id UUID        NOT NULL REFERENCES chatrooms(id) ON DELETE CASCADE,
    user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        VARCHAR(10) NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
    joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (chatroom_id, user_id)
);
CREATE INDEX chatroom_members_user_idx ON chatroom_members (user_id);

CREATE TABLE messages (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chatroom_id         UUID          NOT NULL REFERENCES chatrooms(id) ON DELETE CASCADE,
    sender_id           UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                VARCHAR(10)   NOT NULL DEFAULT 'text'
                        CHECK (type IN ('text','image','audio','file','location')),
    body                VARCHAR(2000) NOT NULL DEFAULT '',
    file_url            TEXT,
    file_name           TEXT,
    mime_type           TEXT,
    file_size           BIGINT,
    lat                 DOUBLE PRECISION,
    lng                 DOUBLE PRECISION,
    reply_to_id         BIGINT        REFERENCES messages(id) ON DELETE SET NULL,
    reply_preview       VARCHAR(200),
    reply_sender_name   VARCHAR(50),
    mentions            UUID[]        NOT NULL DEFAULT '{}',
    pinned              BOOLEAN       NOT NULL DEFAULT FALSE,
    edited              BOOLEAN       NOT NULL DEFAULT FALSE,
    expires_at          TIMESTAMPTZ,                          -- self-destruct messages
    client_message_id   UUID,                                 -- idempotency key from the client
    sequence_number     BIGINT        NOT NULL,               -- per-room monotonic order
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
    -- Backstop 1: one sequence slot per room, ever.
    CONSTRAINT messages_room_seq_uq UNIQUE (chatroom_id, sequence_number)
);
-- Backstop 2: the same client send can never persist twice.
CREATE UNIQUE INDEX messages_client_id_uq ON messages (client_message_id) WHERE client_message_id IS NOT NULL;
-- History pagination: seek on (room, seq) — O(log n) regardless of depth.
CREATE INDEX messages_room_seq_desc_idx ON messages (chatroom_id, sequence_number DESC);
CREATE INDEX messages_room_pinned_idx   ON messages (chatroom_id, created_at DESC) WHERE pinned;
CREATE INDEX messages_expires_idx       ON messages (expires_at) WHERE expires_at IS NOT NULL;
-- Room search: stemmed full-text index (replaces Mongo's $text index).
CREATE INDEX messages_body_fts_idx      ON messages USING GIN (to_tsvector('english', body));
-- Unread badge = COUNT(*) WHERE chatroom_id = ? AND sequence_number > watermark AND sender_id <> me.
CREATE INDEX messages_room_seq_sender_idx ON messages (chatroom_id, sequence_number, sender_id);

CREATE TABLE message_reactions (
    message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      VARCHAR(16) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, user_id, emoji)
);

-- Per-message receipts ("who has seen THIS message" ticks).
CREATE TABLE message_status (
    message_id   BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delivered_at TIMESTAMPTZ,
    read_at      TIMESTAMPTZ,
    PRIMARY KEY (message_id, user_id)
);

-- Per-user, per-room read watermark: the unread badge is one indexed range
-- count instead of one array entry per (user, message).
CREATE TABLE room_read_state (
    user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chatroom_id        UUID        NOT NULL REFERENCES chatrooms(id) ON DELETE CASCADE,
    last_read_sequence BIGINT      NOT NULL DEFAULT 0,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, chatroom_id)
);

-- ── Direct messages (E2EE) ───────────────────────────────────────────────────

-- Exactly two participants, stored ordered so the pair is unique regardless
-- of who started the conversation.
CREATE TABLE conversations (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_low        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_high       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT conversations_pair_ordered CHECK (user_low < user_high),
    CONSTRAINT conversations_pair_uq UNIQUE (user_low, user_high)
);
CREATE INDEX conversations_user_low_idx  ON conversations (user_low,  last_message_at DESC);
CREATE INDEX conversations_user_high_idx ON conversations (user_high, last_message_at DESC);

-- Two shapes discriminated by `type`. For e2ee/v1 the envelope is an opaque
-- JSON document the server validates structurally and can never read.
CREATE TABLE dm_messages (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conversation_id   UUID          NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id         UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_message_id UUID,
    type              VARCHAR(20)   NOT NULL CHECK (type IN ('e2ee/v1','plaintext-legacy')),
    body              VARCHAR(2000) NOT NULL DEFAULT '',
    envelope          JSONB,
    edited            BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT dm_messages_shape CHECK (
        (type = 'e2ee/v1' AND envelope IS NOT NULL) OR
        (type = 'plaintext-legacy' AND envelope IS NULL)
    )
);
CREATE INDEX dm_messages_conv_id_desc_idx ON dm_messages (conversation_id, id DESC);
-- Idempotent retries: the same client send can never persist twice.
CREATE UNIQUE INDEX dm_messages_client_id_uq
    ON dm_messages (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;
-- Replay backstop for E2EE: one (session, counter) slot per sender, ever.
CREATE UNIQUE INDEX dm_messages_replay_uq
    ON dm_messages (conversation_id, sender_id, (envelope->>'sessionId'), ((envelope->>'ctr')::bigint))
    WHERE type = 'e2ee/v1';

-- ── Notifications & audit ────────────────────────────────────────────────────

CREATE TABLE notifications (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type       VARCHAR(30) NOT NULL,           -- dm, mention, room_invite …
    payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    read       BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_unread_idx ON notifications (user_id, created_at DESC) WHERE NOT read;

CREATE TABLE audit_logs (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    UUID        REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(50) NOT NULL,          -- user.login, message.delete, room.role_change …
    target_type VARCHAR(30),
    target_id   VARCHAR(64),
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ip          VARCHAR(45) NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

-- ── Kafka consumer idempotency ledger ────────────────────────────────────────
-- Kafka is at-least-once; every consumer records the event ids it has handled
-- so a redelivery (rebalance, retry, replay) is a no-op. Natural keys
-- (client_message_id, message_status PK) are the first line; this is the
-- explicit second line for consumers that produce side effects.
CREATE TABLE processed_events (
    consumer     VARCHAR(60) NOT NULL,
    event_id     UUID        NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (consumer, event_id)
);
CREATE INDEX processed_events_age_idx ON processed_events (processed_at);   -- retention sweep
