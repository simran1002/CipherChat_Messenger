# CipherChat — Architecture

Self-hostable secure team messaging. Two apps (`chat-back` Express +
Socket.IO + Mongoose, `chat-front` React + Vite), MongoDB for persistence,
Redis for cross-replica coordination. Every decision below has an ADR in
`docs/adr/` with the rejected alternatives.

## System topology (scale-out deployment)

```mermaid
flowchart LR
    B1[Browser A] & B2[Browser B] --> LB[nginx LB\nip_hash sticky]
    LB --> P1[backend pod 1]
    LB --> P2[backend pod 2]
    P1 & P2 --> M[(MongoDB\nmessages, users,\nrooms, envelopes)]
    P1 & P2 --> R[(Redis\ndedup · sequences ·\nrate limits · presence ·\nsocket.io pub/sub)]
    P1 -. "/metrics" .-> PR[Prometheus scrape]
    P2 -. "/metrics" .-> PR
```

- `ip_hash` keeps Socket.IO's long-polling fallback pinned to one pod;
  message fan-out **between** pods rides the Redis adapter, not nginx.
- Per-user rooms (`user:{id}`) address "all of this user's sockets" across
  every pod — raw socketId targeting silently dropped cross-pod messages.
- `docker-compose.scale.yml` runs this exact topology locally; killing
  `backend1` mid-conversation is the standard demo.

## Message delivery pipeline (rooms)

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server (any pod)
    participant R as Redis
    participant DB as MongoDB

    C->>C: optimistic bubble (_pending, clientMessageId=UUID)
    C->>S: chatroomMessage {…, clientMessageId} [timeout 5s]
    S->>S: token-bucket rate limit (Lua, atomic)
    S->>R: GET dedup:{clientMessageId}
    alt duplicate (retry landed twice)
        S-->>C: ACK {ok, messageId: original, duplicate}
    else new
        S->>R: INCR seq:{room} (seeded from Mongo max)
        S->>DB: insert (unique idx on clientMessageId + room/seq backstop)
        S->>R: SET dedup:{clientMessageId} NX EX 600
        S-->>C: ACK {ok, messageId, sequenceNumber}
        S->>S: io.to(room).emit newMessage  (fan-out via Redis adapter)
    end
    Note over C: no ACK in 5s → retry ×4 (backoff+jitter)<br/>→ IndexedDB queue → drained on reconnect
```

Five layers, each covering the one above: ACK/retry → offline queue →
Redis dedup → per-room sequences → DB unique indexes (ADR-0007).

## E2EE handshake and message flow (DMs)

```mermaid
sequenceDiagram
    participant A as Alice (browser)
    participant S as Server
    participant B as Bob (browser)

    Note over A,B: one-time setup: each publishes IK_ed, IK_x, signed prekey
    A->>S: GET /keys/bob
    A->>A: verify prekey sig · 3×DH → SK → chain roots (X3DH-lite)
    A->>A: seal: ctr n → HKDF msg key+IV → AES-256-GCM(AAD=routing)
    A->>S: directMessage {envelope: v,sessionId,ctr,ct,init?}
    S->>S: validate STRUCTURE only (never keys/plaintext)
    S->>B: newDirectMessage {envelope}
    B->>B: (first msg) derive same SK from init · open at ctr n
    Note over A,B: rotation every 200 msgs / 7 days → new session<br/>counter-addressed keys → order/offline-safe
```

The server stores ciphertext envelopes it can never read; sidebar previews
are a client-side encrypted cache; safety numbers (Signal's 60-digit format)
verify identities; an 8-word recovery code restores keys on a new browser.
Rooms are deliberately NOT E2EE — that's the AI-features trade, ADR-0004.

## Auth

15-minute HS256 access tokens + 30-day rotating refresh cookie (httpOnly,
hash-at-rest, replay-after-rotation = theft signal → 401). Axios silently
refreshes and replays once; the socket handshake re-reads the token on every
reconnect. ADR-0005.

## Authorization (rooms)

`services/roomAccess.ts` is the single authority: public rooms admit any
authenticated user (joining records participation), private rooms admit
members only — enforced identically in REST controllers and socket handlers.
Roles: owner → admin → member; invites need admin+, role changes owner-only,
ownership transfer demotes the previous owner.

## Data model (core collections)

| Collection | Purpose | Load-bearing indexes |
|---|---|---|
| `messages` | room messages | `{chatroom, _id}` cursor pagination; unique partial `{chatroom, sequenceNumber}`; unique partial `clientMessageId`; TTL on `expiresAt` |
| `dmmessages` | DM envelopes + legacy plaintext | `{conversationId, createdAt}`; unique `{conversationId, clientMessageId}` |
| `chatrooms` | rooms + embedded members[] | unique `name`; `members.user` |
| `roomreadstates` | per-user unread watermark | unique `{user, chatroom}` |
| `users` | identity + presence + E2EE key directory | unique `email` |
| `refreshtokens` | session store (hashes) | unique `tokenHash`; TTL `expiresAt` |

## Scaling milestones

| Trigger | Change |
|---|---|
| >4 pods / multi-node Redis pressure | Redis Cluster; move presence to its own keyspace |
| Sustained >500 msg/s | Queue (Kafka) between socket ingest and persistence; batch inserts |
| History >100 GB | Room-based sharding; move media to S3 + presigned URLs |
| Multi-org SaaS mode | Tenant id on every collection + per-tenant rate budgets (today: one org per deployment, by design) |
