# API

Base path `/api/v1`. Authoritative, always-current reference: **`/v3/api-docs`** (OpenAPI 3) and **`/swagger-ui.html`**, generated from the controllers by springdoc. This page is the map.

## Conventions

- **Auth**: `Authorization: Bearer <access token>` (15-minute JWT). Refresh via the `CC_Refresh` httpOnly cookie on `POST /auth/refresh`.
- **Ids**: strings. Users, rooms, conversations are UUIDs; messages are numeric strings.
- **Errors**: RFC 9457 `application/problem+json`:

  ```json
  { "status": 409, "title": "Conflict", "detail": "This message counter was already used.",
    "code": "replayed_counter", "timestamp": "2026-09-03T10:11:12Z", "requestId": "…" }
  ```

  Validation failures (`400 validation_failed`) add `"fields": {"email": "must be a well-formed email address"}`. Stable `code` values the client keys on: `bad_credentials`, `2fa_bad_code`, `2fa_pending_invalid`, `refresh_invalid`, `rate_limited`, `invalid_message`, `not_participant`, `replayed_counter`, `forbidden`, `*_not_found`, `ai_not_configured`, `ai_unavailable`, `presign_unsupported`, `unsupported_media_type`, `file_too_large`.
- **Pagination**: cursor-based. Rooms: `?before=<sequenceNumber>&limit=50` → `{messages, chatroom, cursor:{nextCursor, hasMore, limit}}`. DMs: `?before=<messageId>`.
- **Idempotency**: sends accept `clientMessageId` (UUID); a retry returns the original with `duplicate: true`.
- **Correlation**: send `X-Request-Id`; it is echoed and appears in problem bodies and logs.

## Endpoints

### Auth — `/auth`
| Method | Path | Notes |
|---|---|---|
| POST | `/register` | 201 → `{message, token, user}` + refresh cookie |
| POST | `/login` | → session, or `{requires2fa: true, pendingToken}` |
| POST | `/login/2fa` | `{pendingToken, code}` (TOTP or backup code) |
| POST | `/refresh` | cookie → `{token}`; rotates the cookie |
| POST | `/logout` | revokes this session |
| POST | `/password` | `{currentPassword, newPassword}`; signs out other devices |
| GET / DELETE | `/sessions`, `/sessions/{id}` | list / revoke devices |
| POST | `/2fa/setup`, `/2fa/enable`, `/2fa/disable` | enrol (otpauth URI), confirm (returns backup codes once), disable (password + code) |

### Users — `/users`
| GET | `/me` | profile | PATCH | `/me` | `{name?, bio?, dp?}` |
|---|---|---|---|---|---|
| PUT | `/me/presence` | `{presenceStatus, presenceNote}` | GET | `/`, `/{id}` | directory / one user |

### Chatrooms — `/chatrooms`
| Method | Path | Notes |
|---|---|---|
| GET | `/` | rooms visible to the caller with `unreadCount`, `myRole`, `memberCount` |
| POST | `/` | `{name, isPrivate}` → 201 RoomView |
| GET | `/{roomId}/members` · POST `/join` · POST `/invite` `{userId}` · POST `/leave` · PATCH `/members/{userId}` `{role}` | membership & roles (owner/admin/member; promoting to owner transfers ownership) |
| GET | `/{roomId}/messages?before&limit` | history (sequence cursor) |
| POST | `/{roomId}/messages` | `{message, clientMessageId?, replyTo?, expiresIn?, mentions?}` → 201 `{ok, messageId, sequenceNumber, duplicate, message}` |
| POST | `/{roomId}/messages/file` | image/audio/file/location message referencing an uploaded URL |
| GET | `/{roomId}/messages/search?q=` · `/{roomId}/pinned` | full-text search (ILIKE fallback) · pinned (top 10) |
| POST | `/{roomId}/read` | `{upToSequence?}` receipts + watermark |
| PUT / DELETE | `/messages/{id}` | edit (author only) / delete (author only) |
| POST | `/messages/{id}/pin` · `/react` `{emoji}` · `/delivered` | toggle pin · toggle reaction · delivery receipt |

### Conversations (E2EE DMs) — `/conversations`
| Method | Path | Notes |
|---|---|---|
| GET | `/` | `[{id, participant, lastMessage:{message, encrypted, createdAt}, lastMessageAt}]` — content-free for encrypted rows |
| POST | `/` | `{targetUserId}` → 201 (get-or-create, symmetric) |
| GET | `/{id}/messages?before&limit` | `{messages, participant, cursor}`; each message is `type: e2ee/v1` + `envelope` or `plaintext-legacy` + `message` |
| POST | `/{id}/messages` | `{clientMessageId?, envelope}` or `{clientMessageId?, message}` — exactly one; 409 `replayed_counter` on a reused `(sessionId, ctr)` |

### Keys — `/keys`
| PUT | `/` | publish bundle `{identityEd25519, identityX25519, signedPreKey:{keyId, pubX25519, sig}}`; signature verified |
|---|---|---|
| GET | `/me`, `/{userId}` | own / peer bundle with `keyVersion` |
| PUT / GET | `/backup/blob` | opaque client-encrypted recovery blob (≤ 128 KB) |

### Uploads — `/uploads`
| POST | `/` | multipart `file`; MIME allow-list; 10 MB → `{url, fileName, mimeType, fileSize}` |
|---|---|---|
| POST | `/encrypted` | `application/octet-stream` blob → `{url, fileSize}` |
| POST | `/encrypted/presign` | `{size}` → `{uploadUrl, headers, url, expiresSeconds}`; 501 on the local driver |

### AI — `/ai` (rooms only; DMs are E2EE)
`POST /rooms/{roomId}/summarize {limit?}` · `POST /rooms/{roomId}/suggest-reply` · `POST /tone {message}`. 20/min per user; 503 when unconfigured or the circuit is open.

### Notifications — `/notifications`
`GET /?limit` · `GET /unread-count` · `POST /{id}/read` · `POST /read-all`.

### Analytics
`GET /analytics/metrics` — this instance's counters, p50/p95/p99 send latency, WS concurrency, 10-minute snapshot history (feeds the in-app dashboard). Admin: `GET /admin/analytics/overview`, `GET /admin/audit?actorId&limit`.

## WebSocket (STOMP over WS at `/ws`)

Connect with `Authorization: Bearer <token>` as a STOMP header. Heartbeat 25 s both ways.

| Direction | Destination | Payload |
|---|---|---|
| → | `/app/rooms/send` | `{chatroomId, message, clientMessageId?, replyTo?, expiresIn?, mentions?}` |
| ← | `/user/queue/acks` | `{ok, messageId, sequenceNumber, duplicate, error, clientMessageId}` (rooms and DMs) |
| → | `/app/rooms/sync` | `{messages:[…]}` offline-queue drain → ← `/user/queue/sync` `{results:[ack…]}` |
| → | `/app/rooms/read`, `/app/rooms/delivered`, `/app/rooms/typing`, `/app/rooms/stopTyping` | `{chatroomId, …}` |
| → | `/app/dm/send`, `/app/dm/typing`, `/app/dm/stopTyping` | `{conversationId, …}` |
| → | `/app/presence/heartbeat`, `/app/presence/update` | `{}` / `{presenceStatus, presenceNote}` |
| ← | `/topic/rooms/{id}` | `{event, payload}` — `newMessage`, `messagesRead`, `messageDeliveryUpdate`, `reactionUpdated`, `messageEdited`, `messageDeleted`, `messagePinned`, `userTyping`, `userStopTyping` |
| ← | `/topic/dm/{id}` | `newDirectMessage`, `dmUserTyping`, `dmUserStopTyping` |
| ← | `/user/queue/events` | `onlineUsers`, `heartbeatAck`, `dmNotification`, `mentionNotification` |
| ← | `/topic/presence` | `onlineUsers` `{total, users:[…≤100]}` |

Subscriptions to room/DM topics are authorised by membership at `SUBSCRIBE` time.
