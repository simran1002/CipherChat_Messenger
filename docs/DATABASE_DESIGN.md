# Database Design

PostgreSQL 17, schema owned by Flyway (`backend/src/main/resources/db/migration`). Hibernate runs with `ddl-auto: validate` — the entities must match the migration or the app refuses to start; the migration, not the ORM, is the source of truth.

## Principles

1. **Invariants live in the database.** Every "this must happen exactly once" or "these two rows cannot both exist" is a unique index, not a check in application code. Redis and application logic are fast paths; Postgres is the backstop that makes them safe under races, restarts and bugs.
2. **UUIDs for anything that appears in a URL** (users, rooms, conversations) — non-enumerable. **BIGINT identity for messages** — 8-byte keys, cheap indexes, natural ordering, and the id doubles as the DM cursor.
3. **Read models are queries, not columns.** Unread counts, member counts and previews are computed with indexed queries at read time; nothing is denormalised that could go stale.
4. **JSONB only for genuinely opaque data** (E2EE envelopes, notification payloads, audit metadata). Everything the server needs to query is a real column.

## Entity overview

```
users ──┬── refresh_tokens          (device sessions; hashed tokens)
        ├── two_factor              (sealed TOTP seed + hashed backup codes)
        ├── user_keys / key_backups (E2EE public bundle; opaque recovery blob)
        ├── chatroom_members ──── chatrooms ──── messages ──┬── message_reactions
        │                                       │          ├── message_status (delivered/read receipts)
        │                                       └── room_read_state (per-user watermark)
        ├── conversations (user_low < user_high) ──── dm_messages (JSONB envelope)
        ├── notifications
        └── audit_logs
processed_events        (Kafka consumer idempotency ledger)
event_publication       (Spring Modulith outbox — created by the framework)
```

## Tables that carry design decisions

### `messages`

| Column | Notes |
|---|---|
| `id BIGINT IDENTITY` | primary key, insertion order |
| `chatroom_id`, `sender_id` | FKs |
| `sequence_number BIGINT` | per-room, gapless; **`UNIQUE (chatroom_id, sequence_number)`** |
| `client_message_id UUID` | **partial unique index `WHERE client_message_id IS NOT NULL`** |
| `body`, `type`, file/location columns, `reply_*`, `mentions UUID[]`, `pinned`, `edited`, `expires_at` | |
| `search tsvector` (generated) | **GIN** index for full-text search |

Two indexes implement exactly-once persistence:

- `(chatroom_id, sequence_number)` unique: the Redis `INCR` counter hands out slots; if the counter were ever wrong (Redis flushed, seeded from a stale max) the second writer to a slot fails instead of producing two messages with one sequence.
- `client_message_id` unique: a client retry that slipped past the Redis dedup key (TTL expired, Redis restarted) hits this and is resolved to the original row — the ACK still says `duplicate: true`.

History is paginated on `sequence_number` (`WHERE sequence_number < :before ORDER BY sequence_number DESC LIMIT n+1`) — an index range scan regardless of room size, unlike `OFFSET`.

Self-destructing messages: Postgres has no TTL index, so `expires_at` is indexed and swept every minute.

### `room_read_state` and `message_status`

Unread counts are `count(*) WHERE sequence_number > last_read_sequence` per room — one indexed range count per row of the sidebar, no per-message flags. `message_status` holds per-user delivered/read receipts; `mark read up to sequence N` is an upsert with `GREATEST(existing, N)` so out-of-order acknowledgements never move a watermark backwards.

### `conversations`

`(user_low, user_high)` with a CHECK `user_low < user_high` and a unique index: (a,b) and (b,a) are the same row by construction, and two users clicking "start" simultaneously produces one conversation (the loser re-reads).

### `dm_messages`

| Column | Notes |
|---|---|
| `type` | `e2ee/v1` or `plaintext-legacy` (pre-E2EE history stays readable, clearly typed) |
| `body` | legacy plaintext only |
| `envelope JSONB` | `{v, sessionId, ctr, ct, init?}` — server-opaque |
| **replay index** | `UNIQUE (conversation_id, sender_id, (envelope->>'sessionId'), ((envelope->>'ctr')::bigint))` |

The replay index is the server's contribution to the E2EE protocol: a counter within a session is spent exactly once, even if the client is malicious, even across replicas. A retry of the same message (same `client_message_id`) is absorbed as a duplicate; a *different* message reusing `(sessionId, ctr)` is refused with `409 replayed_counter`. The server never has the keys to check anything else — and does not need to.

### `users`

`UNIQUE (lower(email))` — case-insensitive uniqueness at the index, not via a lowercased shadow column. `password_hash` is BCrypt(12); login uses a constant dummy hash for unknown emails so timing does not reveal whether an address exists. `version` enables optimistic locking on profile updates.

### `refresh_tokens`

Only the SHA-256 of the token is stored; rotation is `DELETE … WHERE token_hash = ? RETURNING …` — atomic consume, so a replayed refresh token finds nothing (the signature of theft, audited as `user.refresh_rejected`).

### `two_factor`

The TOTP seed is sealed with AES-256-GCM under a key derived from `SEAL_SECRET` (a DB dump alone cannot generate codes); backup codes are BCrypt-hashed, stored as `text[]`, burned on use.

### `processed_events`

`PRIMARY KEY (consumer, event_id)`; `INSERT … ON CONFLICT DO NOTHING` is the idempotency claim (see `KAFKA_DESIGN.md`). Indexed on `processed_at` for the retention sweep.

## Indexing summary

| Access pattern | Index |
|---|---|
| room history page | `(chatroom_id, sequence_number)` |
| unread count | same index, range + count |
| DM history page | `(conversation_id, id)` |
| sidebar preview per conversation | `DISTINCT ON (conversation_id) … ORDER BY conversation_id, id DESC` on the same index |
| full-text search in a room | GIN on generated `tsvector`, ILIKE fallback for short/non-word queries |
| expiry sweep | partial index `WHERE expires_at IS NOT NULL` |
| inbox | partial `(user_id, created_at DESC) WHERE NOT read` |
| audit by actor / by action | `(actor_id, created_at DESC)`, `(action, created_at DESC)` |

## Connection budget

HikariCP `maximum-pool-size` (`DB_POOL_SIZE`, default 20) × backend replicas must stay below Postgres `max_connections` (RDS parameter group sets 400; Compose sets 200). The Kubernetes ConfigMap sets 10 per pod for a 10-pod ceiling. Virtual threads mean request threads are cheap; DB connections are the scarce resource, which is why the pool, not the thread count, is the knob.

## Migrations

One versioned SQL file per change (`V2__…sql`). Rules: additive first (new nullable column → backfill → constraint), never rename in place, never edit an applied migration. The outbox table is created by Spring Modulith (`schema-initialization.enabled: true`) and excluded from `validate`.
