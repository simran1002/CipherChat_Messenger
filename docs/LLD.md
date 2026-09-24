# Low-Level Design

Class-level design of CipherChat: the objects that carry each guarantee, the exact sequence of calls on the hot paths, the state machines, and the transaction and locking boundaries. Every name below is a real class, method, table, index or STOMP destination in this repository; nothing is aspirational. The high-level picture is in [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md) and [ARCHITECTURE.md](ARCHITECTURE.md); the schema in [DATABASE_DESIGN.md](DATABASE_DESIGN.md); the tests that pin each behaviour in [TESTING.md](TESTING.md).

Contents

1. [Backend module structure](#1-backend-module-structure)
2. [Class design: the send path](#2-class-design-the-send-path)
3. [Sequence: room message, exactly once](#3-sequence-room-message-exactly-once)
4. [Sequence: cross-replica fan-out](#4-sequence-cross-replica-fan-out)
5. [Sequence: the "afterwards" pipeline (outbox → Kafka → consumers)](#5-sequence-the-afterwards-pipeline)
6. [Sequence: encrypted direct message](#6-sequence-encrypted-direct-message)
7. [Sequence: authentication and refresh rotation](#7-sequence-authentication-and-refresh-rotation)
8. [Sequence: STOMP connect and authorisation](#8-sequence-stomp-connect-and-authorisation)
9. [State machines](#9-state-machines)
10. [Client design](#10-client-design)
11. [Transactions, locks and idempotency: the complete list](#11-transactions-locks-and-idempotency)
12. [Error model](#12-error-model)
13. [Concurrency and resource limits](#13-concurrency-and-resource-limits)

---

## 1. Backend module structure

One Spring Boot process; Spring Modulith turns each top-level package under `com.cipherchat` into a module whose allowed dependencies are declared in its `package-info.java` and enforced by `ModularityTests` (the build fails on a violation).

```mermaid
flowchart TB
    subgraph shared["shared  (OPEN — no business logic)"]
        api["api · ApiException, GlobalExceptionHandler"]
        sec["security · JwtAuthenticationFilter, CurrentUser"]
        ev["events · MessagingEvents, AuditEvents"]
        infra["infra · RedisRateLimiter, RedisDeduplicator,<br/>RedisSequenceCounter, AsyncConfig, AppMetrics"]
        kafka["kafka · KafkaInfrastructure, ProcessedEventLedger,<br/>OutboxResubmitter, KafkaHealthIndicator"]
    end
    user
    auth --> user
    chatroom --> user
    dm --> user
    keys --> user
    presence --> user
    ai --> chatroom
    gateway --> chatroom & user & presence & dm & auth
    upload
    notification & audit & analytics
    classDef consumer fill:#1f2937,stroke:#6b7280,color:#fff
    class notification,audit,analytics consumer
```

Modules never call each other's internals; they call each other's public services (`ChatroomService.assertAccess`, `DmService.requireParticipant`, `UserService.require`) or communicate through the event records in `shared.events`, which are simultaneously the in-process events and the Kafka wire format.

## 2. Class design: the send path

```mermaid
classDiagram
    direction LR
    class StompController {
        -MessageService messages
        -DmService dms
        -SimpMessagingTemplate template
        +send(RoomSend, StompPrincipal)
        +sendDm(DmSend, StompPrincipal)
        +sync(OfflineQueue, StompPrincipal)
        -attempt(UUID userId, RoomSend) Ack
    }
    class ChatroomController {
        +send(UUID roomId, SendMessageRequest) SendResult
        +history(roomId, before, limit) CursorPage
    }
    class MessageService {
        -ChatroomService rooms
        -RedisRateLimiter rateLimiter
        -RedisDeduplicator dedup
        -RedisSequenceCounter sequences
        -MessagePersistence persistence
        +send(senderId, roomId, SendMessageRequest) SendResult
        +sendFile(senderId, roomId, SendFileMessageRequest) SendResult
        +history(roomId, userId, beforeSeq, limit) CursorPage
        +deltas(rooms, maxPerRoom) SyncResponse
        -sendDraft(senderId, roomId, Message) SendResult
    }
    class MessagePersistence {
        <<REQUIRES_NEW>>
        +persist(Message draft, String senderName) Message
    }
    class RedisSequenceCounter {
        +next(UUID roomId, LongSupplier persistedMax) long
    }
    class RedisDeduplicator {
        +lookup(roomId, clientMessageId) Optional~Long~
        +mark(roomId, clientMessageId, messageId) boolean
    }
    class RedisRateLimiter {
        +tryAcquire(key, capacity, refillPerSecond) boolean
    }
    class Message {
        +UUID chatroomId
        +UUID senderId
        +long sequenceNumber
        +UUID clientMessageId
        +Type type
    }
    class MessageSent {
        <<record, @Externalized>>
        UUID eventId
        UUID chatroomId
        long sequenceNumber
        List~UUID~ mentions
    }
    StompController --> MessageService
    ChatroomController --> MessageService
    MessageService --> RedisRateLimiter
    MessageService --> RedisDeduplicator
    MessageService --> RedisSequenceCounter
    MessageService --> MessagePersistence
    MessagePersistence ..> MessageSent : publishes (same tx)
    MessagePersistence --> Message
```

Design points that the class shapes encode:

- **`MessagePersistence` is its own bean with `REQUIRES_NEW`.** A `DataIntegrityViolationException` from a unique index marks the *current* transaction rollback-only. If the insert ran inside `MessageService`'s transaction, the service could not then query for the existing row and answer `duplicate: true` — the whole request would be dead. Isolating the insert lets the caller interpret the failure after the inner transaction has rolled back. `DmService.Persistence` exists for the same reason.
- **The domain event is published inside the persisting transaction.** `MessagePersistence.persist` calls `events.publishEvent(MessageSent)` before returning; Spring Modulith writes the event to `event_publication` in that same transaction. A message row and its outbox row commit atomically or not at all — that is the transactional outbox.
- **Both STOMP and REST converge on one `MessageService.send`.** The transport differs (ACK frame vs HTTP body) but the idempotency, sequencing and persistence code path is identical, so a retry over the other transport is still absorbed.
- **Redis classes carry an explicit failure policy each.** `RedisRateLimiter` and `RedisDeduplicator` *fail open* (Redis down → allow / fall through to the unique index). `RedisSequenceCounter` *fails closed* (Redis down → `503 redis_unavailable`), because a guessed sequence would only be caught after the fact.

## 3. Sequence: room message, exactly once

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (useMessageDelivery)
    participant G as StompController
    participant S as MessageService
    participant RL as RedisRateLimiter
    participant D as RedisDeduplicator
    participant Q as RedisSequenceCounter
    participant P as MessagePersistence (REQUIRES_NEW)
    participant PG as PostgreSQL

    C->>G: SEND /app/rooms/send {chatroomId, message, clientMessageId}
    G->>S: send(userId, roomId, req)
    S->>S: rooms.assertAccess(roomId, userId)  → 403 forbidden
    S->>RL: tryAcquire("rl:msg:"+userId, 20, 2/s)
    RL-->>S: false → 429 rate_limited (terminal: client does not retry)
    S->>D: lookup(roomId, clientMessageId)
    alt seen in Redis (fast path, TTL 10 min)
        D-->>S: messageId
        S->>PG: findById(messageId) filtered by chatroomId
        S-->>G: SendResult(duplicate=true)
    else not seen
        S->>PG: findByChatroomIdAndClientMessageId (Redis may have forgotten)
        S->>Q: next(roomId, () → max(sequence_number))
        Note over Q: SET NX seq:room=<db max>  then INCR<br/>Redis down → 503 redis_unavailable
        Q-->>S: seq
        S->>P: persist(draft with seq, senderName)
        P->>PG: INSERT messages … UNIQUE(chatroom_id, sequence_number), UNIQUE(chatroom_id, client_message_id)
        P->>PG: INSERT event_publication (MessageSent)  ← same transaction
        P->>PG: advance room_read_state for the sender
        alt unique-index violation
            PG-->>P: DataIntegrityViolationException (inner tx rolled back)
            S->>PG: findByChatroomIdAndClientMessageId
            S-->>G: SendResult(duplicate=true)  (a retry that beat the Redis check)
        else committed
            S->>D: mark(roomId, clientMessageId, messageId)
            S-->>G: SendResult(duplicate=false, seq)
        end
    end
    G-->>C: MESSAGE /user/queue/acks Ack{ok, messageId, sequenceNumber, duplicate, clientMessageId}
```

Why the sequence cannot go wrong even though it is handed out before the commit: the row carries `UNIQUE (chatroom_id, sequence_number)`. If Redis were ever reseeded from a stale maximum, the second writer to a slot fails the insert rather than producing two messages with one sequence. The unique index is the guarantee; Redis only makes the common case one round trip.

Known gap, stated in the audit: sequences are allocated before commit, so a slower transaction holding `seq 7` can commit after `seq 8`. A delta-sync client that already advanced its cursor to 8 would skip 7. Live broadcast order can also briefly invert. Not fixed in this pass; the honest mitigation is a trailing re-read window on sync.

## 4. Sequence: cross-replica fan-out

Spring's simple STOMP broker only knows the sessions on its own JVM. Every broadcast therefore goes through Redis pub/sub so that N replicas behave as one broker, with no sticky sessions.

```mermaid
sequenceDiagram
    autonumber
    participant P as MessagePersistence (replica A)
    participant M as Spring Modulith
    participant F as DomainEventFanout (replica A)
    participant R as RedisFanout (replica A)
    participant Redis
    participant RB as RedisFanout (replica B)
    participant BB as simple broker (replica B)
    participant Bob as Bob's socket (on replica B)

    P->>M: publishEvent(MessageSent)  [inside the tx]
    M-->>F: after commit: on(MessageSent)  @Async(fanoutExecutor) @ApplicationModuleListener(NOT_SUPPORTED)
    F->>F: messages.view(messageId) (read-only, its own tx)
    F->>R: toRoom(chatroomId, "newMessage", view)
    R->>Redis: PUBLISH ws:room:<id>  {event, payload}
    Redis-->>RB: message on ws:*  (every replica subscribes, including A)
    RB->>BB: simp.convertAndSend("/topic/rooms/<id>", frame)
    BB-->>Bob: MESSAGE /topic/rooms/<id>
    F->>R: toUser(mentionedId, "mentionNotification", …)   for each mention
    R->>Redis: PUBLISH ws:user:<id>
```

- The listener runs **after commit** (Modulith `@ApplicationModuleListener`), so a subscriber can never see a frame for a row that later rolled back.
- `propagation = NOT_SUPPORTED` plus a dedicated `fanoutExecutor`: the listener holds no connection and never blocks the committing thread (both were load-only defects fixed in the benchmark pass, [BENCHMARKS.md](BENCHMARKS.md)).
- Channels: `ws:room:<id>`, `ws:dm:<id>`, `ws:user:<id>`, `ws:all`. Redis pub/sub is fire-and-forget by design: a client that misses a frame catches up from `POST /api/v1/sync/rooms` on reconnect ([ADR-0014](adr/0014-delta-sync-and-background-flush.md)).

## 5. Sequence: the "afterwards" pipeline

Durable side effects (the notification inbox, the audit log, analytics counters) go through Kafka, not pub/sub, because they must survive an outage and must happen exactly once.

```mermaid
sequenceDiagram
    autonumber
    participant PG as event_publication (outbox)
    participant M as Modulith externalizer
    participant K as Kafka message-events
    participant NC as NotificationConsumer
    participant L as ProcessedEventLedger
    participant DB as notifications / processed_events
    participant EH as DefaultErrorHandler
    participant DLT as message-events-dlt

    M->>K: send(key=chatroomId, MessageSent)   after the producing tx commits
    alt broker reachable
        K-->>M: ack (acks=all, idempotent producer)
        M->>PG: completion_date = now()
    else broker down > delivery.timeout.ms (60 s)
        M->>PG: row stays incomplete
        Note over PG: OutboxResubmitter every 15 s: pg_try_advisory_xact_lock →<br/>resubmitIncompletePublicationsOlderThan(75 s)
    end
    K-->>NC: on(MessageSent)   groupId=notifications, ack-mode=record
    NC->>L: claim("notifications", eventId)   [PROPAGATION_MANDATORY: inside the consumer's tx]
    L->>DB: INSERT processed_events ON CONFLICT DO NOTHING
    alt inserted (first delivery)
        NC->>DB: INSERT notifications (one per mention)
        NC-->>K: commit offset
    else conflict (redelivery)
        NC-->>K: skip, commit offset
    end
    alt handler throws (poison record or transient failure)
        EH->>EH: retry 0.5 s, 1 s, 2 s, 4 s
        EH->>DLT: publish original bytes, same partition
    end
```

The exactly-once claim for consumers rests on one rule: **the ledger claim and the side effect commit in the same database transaction.** If the side effect fails, the claim rolls back with it and the retry starts clean; if the offset commit is lost after a successful transaction, the redelivery hits the conflict and is skipped. `ProcessedEventLedger.sweep` bounds the table to Kafka's retention.

## 6. Sequence: encrypted direct message

The server's only cryptographic duties are to verify prekey signatures at publish time, validate envelope *structure*, and enforce the replay index. Everything else happens in the browser.

```mermaid
sequenceDiagram
    autonumber
    participant A as Alice's browser (E2EEService)
    participant KS as keyStore / vault (IndexedDB)
    participant S as Server (DmService)
    participant PG as dm_messages
    participant B as Bob's browser

    A->>KS: withLock(conversationId)   [navigator.locks: one tab ratchets at a time]
    alt v2 session exists, or Double Ratchet opted in
        A->>A: sealV2(session, me, text) → {envelope v2, next state}
        A->>KS: vault.commit(next, plaintext)   ONE IndexedDB tx: ratchet + own plaintext
    else v1 chain session
        A->>A: session.sendCtr++  — keyStore.saveSession   (counter burned BEFORE ciphertext exists)
        A->>A: seal(session, conv, me, ctr, text, init?)
    end
    A->>S: POST /conversations/{id}/messages {clientMessageId, envelope}
    S->>S: requireParticipant · EnvelopeValidator.validate · rate limit
    S->>PG: findByConversationIdAndClientMessageId  (client retry?)
    S->>PG: INSERT dm_messages  UNIQUE(conversation, sender, sessionId, ctr) · UNIQUE(conversation, client_message_id)
    alt replay index fires and it is NOT a client retry
        S-->>A: 409 replayed_counter
    else stored
        S-->>A: 201 SendResult
        S-)B: newDirectMessage {conversationId, userId, user{}, envelope}  via outbox → fan-out
    end
    B->>KS: vault.loadMessage(key)?  (already seen by another tab?)
    B->>KS: withLock(conversationId)
    B->>B: openV2 / open  → plaintext, next state
    B->>KS: vault.commit(next, plaintext)
```

Two invariants that the ordering in this diagram protects:

1. **A counter or message key is never reused.** The v1 counter is persisted before the ciphertext exists; the v2 ratchet advances and commits together with the plaintext it produced, in one IndexedDB transaction (`vault.commit`). A crash between those steps burns a number; it can never reuse one. Nonce reuse under AES-GCM would be catastrophic, so this ordering is load-bearing.
2. **Decrypt is transactional.** `ratchetDecrypt` returns the next state; the caller commits it only after decryption succeeded. A forged or corrupted frame therefore never advances the ratchet.

## 7. Sequence: authentication and refresh rotation

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (api.ts interceptor)
    participant AC as AuthController
    participant T as AuthThrottle
    participant AS as AuthService
    participant RT as RefreshTokenService
    participant PG as refresh_tokens

    C->>AC: POST /auth/login {email, password}
    AC->>T: login(ip, email)   buckets: rl:auth:ip:<ip> (100/15 min), rl:auth:login:<ip>:<sha256(email)[:12]> (10/15 min)
    AC->>AS: login()  @Transactional(NOT_SUPPORTED): BCrypt runs outside any transaction
    AS->>AS: users.authenticate (BCrypt 12, dummy hash when the email is unknown — no timing oracle)
    alt 2FA enabled
        AS-->>C: {requires2fa, pendingToken}  (scope claim rejects it as an access token)
        C->>AC: POST /auth/login/2fa {pendingToken, code}
        AC->>T: twoFactor(userId)  rl:auth:2fa:<userId> (10/5 min)
    end
    AS->>RT: issue(userId, ip)  → new family_id
    RT->>PG: INSERT refresh_tokens (token_hash=SHA-256(raw), family_id, expires_at)
    AS-->>C: {token: JWT (15 min, HS256, sub=userId)} + Set-Cookie CC_Refresh (httpOnly, path-scoped)

    Note over C: 15 minutes later: a request gets 401
    C->>AC: POST /auth/refresh  (cookie only — concurrent 401s share one refresh promise)
    AC->>RT: rotate(raw, ip)
    RT->>PG: SELECT by token_hash
    alt unknown or expired
        RT-->>AC: UNKNOWN → 401, cookie cleared
    else used_at IS NULL and markUsed() == 1
        RT->>PG: UPDATE used_at=now()  (atomic: exactly one presenter wins)
        RT->>PG: INSERT successor in the SAME family
        RT-->>AC: ROTATED → 200 {token} + new cookie
    else used within 10 s
        RT-->>AC: CONCURRENT (a sibling tab lost the race) → 401, cookie KEPT
    else used earlier than 10 s ago
        RT->>PG: DELETE WHERE family_id = …   [REQUIRES_NEW: survives the caller's 401 rollback]
        RT-->>AC: REUSED → 401 + audit user.refresh_reuse_detected {sessionsRevoked}
    end
```

The family model is what makes reuse detection *do* something: the thief and the owner hold tokens of the same family, the server cannot tell them apart, so it signs both out. The 10 s grace window exists because two tabs sharing one cookie legitimately present the same token within moments of each other; inside it the loser is refused but nothing is revoked.

## 8. Sequence: STOMP connect and authorisation

```mermaid
sequenceDiagram
    autonumber
    participant C as Client (stompSocket.ts)
    participant I as StompAuthInterceptor (inbound channel)
    participant J as JwtService
    participant R as ChatroomService / DmService
    participant B as simple broker

    C->>I: CONNECT  Authorization: Bearer <access token>   (header, never the URL)
    I->>J: parseAccessToken
    I->>I: accessor.setUser(StompPrincipal{name = userId})   → routes /user/queue/*
    C->>I: SUBSCRIBE /user/queue/acks, /user/queue/events, /user/queue/sync, /topic/presence
    C->>I: SUBSCRIBE /topic/rooms/{id}
    I->>R: rooms.assertAccess(id, userId)   → AccessDeniedException = ERROR frame, no subscription
    C->>I: SUBSCRIBE /topic/dm/{id}
    I->>R: dms.requireParticipant(id, userId)
    C->>I: SEND /app/rooms/send
    I->>I: destination startsWith "/app/"? else AccessDeniedException
    Note over I,B: A SEND to /topic/** or /user/** is refused before the broker sees it —<br/>otherwise the broker would relay a forged frame verbatim.
    I->>B: forward to @MessageMapping handler
```

Authorisation is at SUBSCRIBE and SEND time only. A socket that outlives a logout, a password change or a room removal is not disconnected — an open item from the audit.

## 9. State machines

### Message delivery (client, `DeliveryState`)

```mermaid
stateDiagram-v2
    [*] --> sending: send() with socket connected
    [*] --> queued: send() with socket disconnected → OfflineQueue.enqueue
    sending --> sent: ACK ok
    sending --> sending: ACK timeout (5 s) → retry, exponential backoff + jitter, ≤ MAX_RETRIES
    sending --> failed: ACK error rate_limited / forbidden / invalid_message (terminal, no retry)
    sending --> queued: retries exhausted → enqueue
    queued --> sending: reconnect → OfflineQueue.drain (same clientMessageId)
    sent --> delivered: messageDeliveryUpdate frame
    delivered --> read: messagesRead frame (watermark ≥ sequence)
    failed --> [*]
```

The same `clientMessageId` travels through every transition, which is what lets a retry, a queue drain and a service-worker flush all be absorbed as `duplicate: true` rather than becoming second rows.

### E2EE identity (client, `E2EEStatus`)

```mermaid
stateDiagram-v2
    [*] --> loading: ensureReady()
    loading --> ready: local identity AND server key matches
    loading --> needs_setup: no local keys, nothing published
    loading --> needs_restore_or_reset: no local keys, but a published identity exists (new browser, or another device reset)
    loading --> unavailable: request failed
    needs_setup --> ready: setUp() → generate, publish, backup, show recovery code once
    needs_restore_or_reset --> ready: restore(code) → unwrap the server-held blob
    needs_restore_or_reset --> ready: reset() → new identity — peers see a safety-number change
    ready --> [*]: DeviceOwner.claim(other user) wipes stores and refresh()es the cache
```

### Refresh-token row

```mermaid
stateDiagram-v2
    [*] --> live: issue() (new family, or successor in an existing one)
    live --> used: rotate() wins markUsed()  → successor issued
    live --> revoked: logout / revokeSession / revokeOthers / password change  (whole family)
    used --> revoked: presented again after the 10 s grace → whole family deleted
    used --> swept: sweepExpired() after 7 days
    live --> swept: expires_at passed
```

### Outbox publication (`event_publication` row)

```mermaid
stateDiagram-v2
    [*] --> incomplete: written in the producing transaction
    incomplete --> completed: Kafka ack → completion_date set (completion-mode: delete)
    incomplete --> incomplete: send failed (broker down) — producer retries within delivery.timeout.ms
    incomplete --> resubmitted: older than 75 s → OutboxResubmitter (advisory-lock leader) every 15 s
    resubmitted --> completed: Kafka ack
    incomplete --> completed: application restart (republish-outstanding-events-on-restart)
```

## 10. Client design

```mermaid
classDiagram
    direction TB
    class App {
        setupSocket()
        handleLogout()
    }
    class stompSocket {
        <<Socket.IO-shaped adapter over @stomp/stompjs>>
        wantedRooms : Set
        wantedDms : Set
        rooms : Map~id, StompSubscription~
        emit(event, payload, ack?)
        on(event, handler)
        timeout(ms).emit(...)
    }
    class useMessageDelivery {
        send(input) SendResult
        pendingCount
    }
    class OfflineQueue {
        <<IndexedDB CipherChat/offlineQueue>>
        enqueue(item)
        drain(socket)
        drainDms(socket, encrypt)
    }
    class E2EEService {
        <<module singleton>>
        ensureReady() E2EEStatus
        encrypt(conv, peer, text) AnyEnvelope
        decrypt(conv, sender, envelope, own) DecryptResult
        encryptionStatus(conv)
        shredConversation(conv)
    }
    class keyStore {
        <<IndexedDB CipherChatKeys>>
        identity · sessions · peers · previews · meta
        withLock(name, fn)
    }
    class vault {
        <<IndexedDB CipherChatVault>>
        deks · ratchets · messages
        commit(conv, session, message?)
        shredConversation(conv)
    }
    class DeviceOwner {
        claim(userId)
    }
    class searchClient {
        <<Web Worker, Orama>>
        indexMessages · searchMessages · shredConversationIndex
    }
    App --> stompSocket
    App --> DeviceOwner
    useMessageDelivery --> stompSocket
    useMessageDelivery --> OfflineQueue
    E2EEService --> keyStore
    E2EEService --> vault
    E2EEService --> searchClient
    DeviceOwner --> keyStore
    DeviceOwner --> vault
    DeviceOwner --> searchClient
    DeviceOwner --> OfflineQueue
    DeviceOwner --> E2EEService : refresh()
```

- **`stompSocket` keeps two sets.** *Wanted* subscriptions (what pages asked for) survive disconnects and are replayed on every connect; *live* subscriptions belong to one connection and are cleared with it. This is the fix for joins issued before the first connect completed.
- **Immutable crypto state.** `ratchetEncrypt`/`ratchetDecrypt`/`sealV2`/`openV2` return the *next* state instead of mutating; the caller decides when it is committed. The backend's CRDT types follow the same pattern.
- **Three IndexedDB databases, one owner.** `DeviceOwner.claim(userId)` runs before the socket or E2EE is touched after sign-in; a different user id wipes all three databases, the offline queue and the in-memory identity cache. The same user id is a no-op, so v2 history — whose only copy is the vault — survives an ordinary logout.

## 11. Transactions, locks and idempotency

| Where | Mechanism | Purpose |
|---|---|---|
| `MessagePersistence.persist`, `DmService.Persistence` | `REQUIRES_NEW` | Interpret a unique-index violation after rollback and answer `duplicate: true` instead of failing the request |
| `MessagePersistence.persist` | event published inside the tx | Message row + outbox row commit atomically |
| `AuthService.login/register` | `NOT_SUPPORTED` + `TransactionTemplate` | BCrypt (≈ 250 ms) never pins a pooled connection; only the audit + session insert are transactional |
| `RefreshTokenService.rotate` | `UPDATE … WHERE used_at IS NULL` returning 1 | Exactly one of N concurrent presenters wins, no lock, no version column |
| `RefreshTokenService.rotate` (reuse branch) | `REQUIRES_NEW` | Family revocation survives the caller throwing 401 |
| `AuditPublisher.publishDetached` | detached tx | A failed login's rollback cannot erase its own audit evidence |
| `ProcessedEventLedger.claim` | `MANDATORY` + `ON CONFLICT DO NOTHING` | Claim and side effect are one transaction; redelivery is a no-op |
| `OutboxResubmitter.resubmit` | `pg_try_advisory_xact_lock` | One replica resubmits per tick; released at commit, a crashed pod cannot strand it |
| `RedisSequenceCounter.next` | `SET NX` then `INCR` | Concurrent seeders cannot reset the counter; `UNIQUE (chatroom_id, sequence_number)` backstops it |
| `RedisDeduplicator` | `SET NX EX 600` keyed `dedup:<room>:<clientId>` | Fast-path duplicate answer across replicas; scoped per room |
| `RedisRateLimiter` | one Lua script (refill + consume) | Token bucket shared by all replicas with no read-modify-write race |
| `messages` | `UNIQUE (chatroom_id, client_message_id)` | Idempotency backstop, per room |
| `dm_messages` | `UNIQUE (conversation_id, sender_id, session_id, ctr)` | E2EE replay backstop, cluster-wide |
| `vault.commit` (client) | one IndexedDB transaction | Ratchet advance and its plaintext persist together or not at all |
| `keyStore.withLock` (client) | `navigator.locks` | One tab ratchets a conversation at a time; the other finds the plaintext in the vault |
| `dek()` (client) | `add`, not `put` | A racing tab cannot replace a conversation key already in use |

## 12. Error model

Every expected failure is an `ApiException(status, code, message)`; `GlobalExceptionHandler` renders it as an RFC 9457 problem document. Clients branch on `code`, never on the message.

| Code | Status | Raised by | Client behaviour |
|---|---|---|---|
| `validation_failed` (+ `fields`) | 400 | bean validation | show per-field |
| `invalid_message`, `invalid_envelope` | 400 | services, `EnvelopeValidator` | terminal, no retry |
| `bad_credentials`, `2fa_bad_code`, `2fa_pending_invalid`, `refresh_invalid`, `unauthorized` | 401 | auth | back to sign-in; `refresh_invalid` clears the cookie |
| `forbidden` | 403 | `assertAccess`, `requireParticipant`, role checks | terminal |
| `not_found` variants | 404 | services | terminal |
| `no_keys` | 404 | key directory | peer has no E2EE keys — the DM page currently falls back to `plaintext-legacy` (audit item) |
| `replayed_counter` | 409 | DM replay index | never retry with the same counter |
| `pii_detected` | 422 | `PiiGuard` | nothing was sent to the model; fix redaction |
| `rate_limited` | 429 | `RedisRateLimiter`, `AuthThrottle` | terminal for a send; back off |
| `redis_unavailable` | 503 | `RedisSequenceCounter` | retry with backoff (same `clientMessageId`) |
| `ai_unavailable`, `ai_not_configured` | 503 | `LlmClient` circuit breaker | show as unavailable |
| `server_error` | 500 | catch-all | STOMP ACK path retries; REST does not |

Over STOMP the same codes arrive in `Ack.error`; `useMessageDelivery.terminalAckError` decides which are terminal (`rate_limited`, `forbidden`, `invalid_message`) and which retry (timeout, `server_error`).

## 13. Concurrency and resource limits

| Resource | Setting | Reason |
|---|---|---|
| HikariCP pool | 20 per pod (`DB_POOL_SIZE`; 10 each in the two-replica profile) | Postgres `max_connections=200` shared by replicas, consumers and the outbox |
| Fan-out executor | dedicated `ThreadPoolTaskExecutor`, queue-backed | Fan-out must never block the committing request thread (load-found defect) |
| Kafka consumer concurrency | 3 per topic, 6 partitions | Parallelism ceiling per consumer group; partition key = room / conversation / user keeps per-entity order |
| STOMP inbound message size | 64 KB | An E2EE envelope with its init block is < 2 KB |
| STOMP send buffer / send time | 512 KB / 10 s | A slow subscriber is disconnected rather than allowed to hold memory |
| Heartbeats | 25 s both ways | Dead sockets are detected within ~50 s |
| Presence TTL | 90 s (heartbeat every 30 s) | A pod that dies without disconnects expires its users instead of ghosting them |
| Typing TTL | 4 s | Keys expire on their own if the owning pod dies |
| Message rate limit | burst 20, refill 2/s per user | Shared bucket across replicas |
| Auth throttle | 100/15 min per address; 10/15 min per (address, account); 10/5 min per account on 2FA | Bounds guessing and BCrypt CPU without offering a lock-out lever |
| Dedup cache TTL | 10 min | Bounds Redis memory; the unique index covers anything older |
| Refresh-token retention | used rows 7 days | Bounds the table; a replay older than that is refused as unknown anyway |
| `processed_events` retention | a little over Kafka retention | A redelivery older than retention cannot occur |
| Double Ratchet skipped keys | 1000 per step, 2000 stored | A malicious peer cannot force unbounded key derivation |
