# CipherChat Messenger

A full-featured, production-grade real-time chat application built on the MERN stack. Goes well beyond basic messaging — WhatsApp/Slack-level UX, AI-powered composition tools, a complete media pipeline, and a distributed-systems reliability layer modelled on SDE-2 system design patterns.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 (CRA), Tailwind CSS v3, Framer Motion, Socket.IO client 4.7 |
| Backend | Node.js 20, Express 4.18, Socket.IO 4.7 |
| Database | MongoDB Atlas (Mongoose 7) |
| Auth | JWT stored in `localStorage`, bcryptjs (12 rounds) |
| AI | Anthropic Claude Haiku (`@anthropic-ai/sdk`, lazy-init) |
| Translation | MyMemory free REST API (no key required) |
| File storage | Local `/uploads/` via multer (10 MB limit, MIME whitelist) |
| Offline storage | Browser IndexedDB (native API, no library) |
| Logging | winston structured JSON logger |

---

## Project Structure

```
Cipher_Messenger/
├── chat-back/                  Express + Socket.IO server
│   ├── controllers/
│   │   ├── chatroomController.js
│   │   └── userController.js
│   ├── middlewares/
│   │   ├── auth.js             JWT guard
│   │   └── upload.js           multer config
│   ├── models/
│   │   ├── Message.js          Full schema incl. delivery/read fields
│   │   ├── User.js             Presence + profile fields
│   │   ├── Chatroom.js
│   │   └── DirectMessage.js
│   ├── routes/
│   │   ├── chatroom.js
│   │   ├── user.js
│   │   ├── directMessage.js
│   │   ├── upload.js
│   │   ├── ai.js
│   │   ├── presence.js
│   │   └── analytics.js
│   ├── shared/                 SDE-2 infrastructure modules
│   │   ├── MessageDeduplicator.js
│   │   ├── SequenceCounter.js
│   │   ├── TypingStateManager.js
│   │   PresenceHeartbeat.js
│   │   ├── RateLimiter.js
│   │   └── MetricsCollector.js
│   ├── utils/
│   │   └── logger.js
│   └── server.js               Socket.IO event hub
│
└── chat-front/                 React SPA
    └── src/
        ├── Pages/
        │   ├── ChatroomPage.js     Main chat view
        │   ├── DirectMessagesPage.js
        │   ├── DashboardPage.js
        │   ├── LoginPage.js
        │   ├── RegisterPage.js
        │   └── ProfilePage.js
        ├── components/
        │   ├── MessageList.js       Bubble renderer + delivery ticks
        │   ├── MessageInput.js      Full toolbar (emoji/file/location/voice/AI/timer)
        │   ├── MessageEdit.js
        │   ├── MessageDelete.js
        │   ├── EmojiPickerWrapper.js
        │   ├── VoiceRecorder.js
        │   ├── ReactionPicker.js    Floating 6-emoji bar
        │   ├── TranslateButton.js   Per-message globe icon
        │   ├── AICoPilot.js         Summarize + suggest replies panel
        │   ├── SelfDestructPicker.js
        │   ├── SensitiveDataDetector.js  Client-side regex scanner
        │   ├── PinnedMessages.js
        │   ├── MessageSearchBar.js
        │   ├── ScrollToBottomFAB.js
        │   ├── NotificationsPanel.js
        │   ├── OnlineUsersSidebar.js
        │   ├── PresencePicker.js
        │   └── Header.js
        ├── hooks/
        │   └── useMessageDelivery.js   ACK + retry + offline fallback
        └── services/
            ├── api.js                  Axios instance
            ├── OfflineQueue.js         IndexedDB queue
            ├── HeartbeatService.js     Presence keepalive
            └── NotificationService.js  Browser push
```

---

## Getting Started

### Prerequisites

- Node.js 20+
- MongoDB Atlas cluster (or local `mongod`)
- (Optional) Anthropic API key for AI features

### Backend

```bash
cd chat-back
npm install
```

Create `chat-back/.env`:

```env
DATABASE=mongodb+srv://<user>:<pass>@cluster.mongodb.net/cipherchat
SECRET=your_jwt_secret_here
PORT=8000
ENV=DEVELOPMENT
ANTHROPIC_API_KEY=sk-ant-...        # optional — AI Co-Pilot + tone detection
FRONTEND_URL=http://localhost:3001  # extra CORS origin if needed
```

```bash
npm run dev   # nodemon with auto-restart
```

### Frontend

```bash
cd chat-front
npm install
```

Create `chat-front/.env`:

```env
REACT_APP_API_URL=http://localhost:8000
```

```bash
npm start     # CRA dev server — runs on :3001 (if :3000 is taken)
```

> Both servers must run simultaneously. The frontend reads `REACT_APP_API_URL` for all HTTP and WebSocket connections.

---

## Features

### Messaging Core

- Real-time group chatrooms and 1-to-1 Direct Messages via Socket.IO
- Message **edit** and **delete** (own messages only), live-synced to all clients
- **Reply-to threading** — border-left quote block with sender name and preview
- **Emoji reactions** — floating 6-emoji picker, grouped tallies, click to toggle, real-time sync
- **Pinned messages** — collapsible banner, up to 10 per room, unpin from banner
- **Message pagination** — 50 per page, load-older button, preserves scroll position
- **Full-text search** within a chatroom — result count badge, highlights match context

### Media & Attachments

- **File upload** — images, audio, PDFs, Office docs, plain text; 10 MB cap; multer MIME whitelist
- **Voice recording** — browser `MediaRecorder` API, `audio/webm`, preview player before send, discard option
- **Location sharing** — `navigator.geolocation`, OpenStreetMap static tile embed + "View on map" link
- **Image bubbles** — click-to-open full size in new tab
- **Audio bubbles** — inline `<audio>` player
- **File bubbles** — clip icon, file name, size label, download link

### Input Toolbar (left → right)

| Button | Function |
|--------|----------|
| 😊 Emoji | `@emoji-mart/react` picker, dark theme, no preview |
| 📎 Attach | File picker → upload → sends as image/audio/file bubble |
| 📍 Location | Geolocation → OpenStreetMap embed |
| 🔥 Timer | `SelfDestructPicker` — 30 s / 5 min / 1 h / 24 h / Never |
| ✨ AI | Toggle `AICoPilot` panel (summarise + reply suggestions) |
| 🎤 / ➤ | Mic when input empty → `VoiceRecorder`; send arrow when text present |

### UI / UX

- **Gradient dark theme** — violet/navy/deep-blue chat background, radial ambient glow
- **WhatsApp-style bubbles** — gradient violet for own, gray-700 for received; `rounded-br-sm` / `rounded-bl-sm` tail corners
- **Avatars on received messages** — profile photo or color-hash initials (same color every session)
- **Date dividers** between message groups
- **Hover action toolbar** — reply / react / pin / edit / delete, only visible on hover
- **Scroll-to-bottom FAB** — fixed position, unread count badge, smooth scroll
- **Connection status indicator** — `SignalIcon` green (connected) / `SignalSlashIcon` red pulsing (offline — messages queued)
- **Pending count** in chatroom subtitle — "3 sending…" while ACKs are in flight
- **Animated transitions** throughout — `AnimatePresence`, `motion.div` with layout animations
- **Responsive layout** — mobile sidebar toggle for the online users panel

### Self-Destruct Messages

- `SelfDestructPicker` component — clock/fire icon in toolbar, dropdown with preset TTLs
- Fire icon and "🔥 Next message self-destructs in Xm" strip shown below input when active
- `expiresAt = Date.now() + expiresIn * 1000` set on save; MongoDB TTL index (`expireAfterSeconds: 0`, partial filter) handles auto-deletion
- Timer resets after each sent message; pinned messages are TTL-exempt

### Optimistic UI

Messages appear instantly in the bubble list as `_pending: true` before the server ACK arrives. Once the server ACKs, the optimistic bubble is replaced with the persisted document (matched by `clientMessageId`). If the ACK never arrives (network drop), the hook retries with exponential backoff, then falls back to the IndexedDB queue with a ⏳ queued tick.

### AI Features

> All AI routes fail gracefully with a clear message when `ANTHROPIC_API_KEY` is not set.

| Feature | Trigger | Model | Tokens |
|---------|---------|-------|--------|
| **Summarise conversation** | AI Co-Pilot → "Summarize" | claude-haiku-4-5-20251001 | 300 |
| **Reply suggestions** | AI Co-Pilot → "Suggest replies" | claude-haiku-4-5-20251001 | 200 |
| **Tone detection** | Auto after 1.5 s typing pause (>15 chars) | claude-haiku-4-5-20251001 | 100 |

**AI Co-Pilot panel** — toggled by ✨ in the chatroom header or the toolbar. Shows:
- Bullet-point conversation summary
- Three clickable reply suggestions that paste into the input

**Tone detection** — live banner above the input:
- Detects: Positive 😊 / Excited 🎉 / Frustrated 😤 / Harsh ⚡ / Sad 😢
- Shows tone label + "Use softer version" one-tap link that replaces the draft
- Dismissible with ✕; silently skipped if AI not configured

**Translation** — globe icon on every text message bubble:
- 8 languages: Hindi, Spanish, French, German, Japanese, Chinese, Arabic, Portuguese
- Powered by MyMemory free API — no key required
- Translated text animates in below the bubble; click globe again to dismiss

### Sensitive Data Detection

`SensitiveDataDetector.js` — pure client-side, zero latency, no network call.

Patterns detected:
| Type | Example pattern |
|------|----------------|
| OTP / verification code | 4–8 digit codes |
| Credit / debit card | 13–19 digit sequences |
| Password in text | `password: ...`, `pwd=...` |
| API key | `sk-`, `Bearer `, `token=` |
| Phone number | various national formats |
| Email address | standard RFC pattern |

Shown as a red shield banner above the input: `"Credit card detected — avoid sharing card numbers over chat."`

### Presence & Online Status

- **Online users sidebar** — real-time list, color-hash avatars, presence emoji overlay (bottom-right of avatar)
- **7 presence states** with emoji + color:

| State | Emoji | Color |
|-------|-------|-------|
| Available | 🟢 | green |
| Coding | 💻 | blue |
| In Meeting | 📅 | red |
| Focusing | 🎯 | orange |
| Driving | 🚗 | yellow |
| Away | 🌙 | slate |
| Busy | 🔴 | rose |

- **Presence note** — 80-char custom status shown under name
- **PresencePicker** — shown inline for own user row, calls `PUT /presence` + emits `presenceUpdate` socket event immediately
- **Last seen** — stored on `User.lastSeen` at socket disconnect
- **Ghost-online prevention** — TTL heartbeat auto-marks offline on tab crash (see SDE-2 section)

### Notifications

- **In-app bell** — red dot badge, `NotificationsPanel` dropdown, lists DM notifications with "mark all read"
- **Browser push** — `Notification API`, requests permission on first chatroom open, fires when tab is hidden and a message arrives
- **DM notification** — `dmNotification` socket event delivers name + preview to the recipient's socket even if they're in a different room

### User Profiles

- `/profile` page — cover gradient, avatar with camera overlay, name/bio inline edit
- Profile photo upload (`PUT /user/profile` multipart)
- **Auto-login after registration** — `POST /user/register` returns `{ token, user }`; frontend stores both and navigates to dashboard without a separate login step

---

## SDE-2 Reliability Layer

All modules live in `chat-back/shared/`. Each has a comment describing the exact Redis/external-system swap for production.

### 1 — Message Delivery Guarantee (At-Least-Once + Exactly-Once Hybrid)

```
Client                         Server
  |  chatroomMessage + UUID ──►  |  dedup check (MessageDeduplicator)
  |  ◄── ACK { ok, messageId }   |  assign sequenceNumber (SequenceCounter)
  |                              |  save to MongoDB
  |  [no ACK in 1s] retry ──►   |  duplicate → ACK with existing id, no re-save
  |  [4 retries fail] ──► IDB   |
  |  [reconnect] syncQueue ──►   |  dedup + save + broadcast
```

| Module | File | Production swap |
|--------|------|----------------|
| Deduplication | `MessageDeduplicator.js` | `SET clientId serverId EX 600 NX` (Redis) |
| Sequence counter | `SequenceCounter.js` | `INCR {room}:seq` (Redis) |
| ACK + retry hook | `chat-front/src/hooks/useMessageDelivery.js` | — |
| Offline queue | `chat-front/src/services/OfflineQueue.js` | IndexedDB → stays client-side |

Retry schedule: 1 s → 2 s → 4 s → 8 s (exponential backoff + ±20% jitter). After 4 failures the message is written to IndexedDB and drained on the next successful reconnect.

### 2 — Delivery & Read Receipts

**Delivery ticks** (own messages only):

| Tick | Meaning |
|------|---------|
| ◌ | Sending — pending ACK |
| ⏳ | Queued offline — saved to IndexedDB |
| ✓ | Sent — server ACKed |
| ✓✓ (gray) | Delivered — at least one other device received it |
| ✓✓ (blue) | Read — at least one recipient scrolled past it |

- `deliveredTo[]` — pushed to on every `messageDelivered` socket event; broadcast as `messageDeliveryUpdate`
- `readBy[]` — batch-updated by `markRead` socket event (fired when user scrolls to bottom or opens the room); broadcast as `messagesRead`
- Both fields are indexed on `Message` and returned in the initial load payload

### 3 — Token-Bucket Rate Limiter (Socket Layer)

`RateLimiter.js` — per-user token bucket checked before every `chatroomMessage` handler:
- Capacity: 20 tokens (burst)
- Refill rate: 2 tokens / second
- On rejection: `rate_limited` ACK → client shows toast, removes optimistic bubble
- Bucket cleared on disconnect (no memory leak)
- Production: Redis `DECRBY` + `EXPIRE` (atomic, cross-node)

### 4 — TTL-Based Typing Indicator

`TypingStateManager.js` — per-room, per-user `setTimeout` of 4 s:
- Every `typing` event restarts the timer
- If `stopTyping` never fires (tab crash, killed process), the timer fires and broadcasts `userStopTyping` automatically
- `clearUser()` called on socket disconnect cleans up all rooms for that user
- Eliminates "ghost typing" indicators permanently

### 5 — Presence Heartbeat

`PresenceHeartbeat.js` — server-side `setInterval` per connected user:
- Client sends `heartbeat` ping every **25 s** (`HeartbeatService.js`)
- Server resets miss count on each ping
- After **2 missed pings (~60 s)** → marks user offline in DB + emits updated `onlineUsers`
- Prevents "ghost online" state when a browser tab crashes without triggering `disconnect`

### 6 — Offline-First Sync Engine

```
Offline:  keystroke → optimistic bubble (⏳) → IndexedDB enqueue
Online:   socket connect → HeartbeatService.start() → OfflineQueue.drain()
drain():  emit syncOfflineQueue{ messages[] } → server deduplicates each
          → server broadcasts newMessage per item → IDB rows deleted on confirm
```

Cap: 50 queued messages drained per reconnect (server-side guard).

### 7 — Real-Time Analytics

`MetricsCollector.js` — singleton, tracks across process lifetime:

| Metric | Description |
|--------|-------------|
| `messageSent` | Total attempted |
| `messageDelivered` | Server saved + broadcast |
| `messageFailed` | DB error on save |
| `duplicatesRejected` | Caught by deduplicator |
| `rateLimitHits` | Rejected by token bucket |
| `deliveryRatePct` | `delivered / sent × 100` |
| `latency.p50/p95/p99` | End-to-end ms from socket receive to broadcast |
| `concurrency.current/peak` | Live socket connection count |
| `snapshots[]` | 1-minute rolling window, last 60 kept (1 h) |

**Endpoint:** `GET /analytics/metrics` — requires JWT.

Production: emit each event to Kafka topic → ClickHouse for time-series; or expose as Prometheus `/metrics` → Grafana dashboard.

---

## Data Model

### `Message`

```js
{
  chatroom, user,
  type,           // "text" | "image" | "audio" | "file" | "location"
  message,        // text content (max 2000 chars)
  fileUrl, fileName, mimeType, fileSize,
  lat, lng,
  replyTo:        { messageId, preview, senderName },
  reactions:      [{ emoji, user, name }],
  pinned,
  edited, deleted,
  expiresAt,      // MongoDB TTL — auto-delete when reached

  // Delivery guarantee fields
  clientMessageId,   // UUID v4 from client — dedup key
  sequenceNumber,    // per-room monotonic counter
  deliveredTo:    [userId, ...],
  readBy:         [{ user, readAt }, ...],
}
```

Indexes: `chatroom+createdAt`, `chatroom+pinned`, `chatroom+sequenceNumber`, `clientMessageId` (sparse), full-text on `message`, TTL on `expiresAt`.

### `User`

```js
{
  name, email, password,
  dp,              // profile photo path
  bio,             // max 160 chars
  isOnline, lastSeen,
  presenceStatus,  // "available"|"coding"|"in_meeting"|"focusing"|"driving"|"away"|"busy"
  presenceNote,    // max 80 chars
}
```

---

## API Reference

### Auth
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/user/register` | `name, email, password` | Register — returns `{ token, user }` for auto-login |
| POST | `/user/login` | `email, password` | Login — returns JWT |
| GET | `/user/profile` | — | Get own profile |
| PUT | `/user/profile` | `name, bio, dp (file)` | Update profile + photo |

### Chatrooms
| Method | Path | Description |
|--------|------|-------------|
| GET | `/chatroom` | List all chatrooms |
| POST | `/chatroom` | Create chatroom |
| GET | `/chatroom/:id/messages?page=&limit=` | Paginated messages (default 50/page) |
| GET | `/chatroom/:id/messages/search?q=` | Full-text search (max 50 results) |
| GET | `/chatroom/:id/pinned` | Pinned messages (max 10) |
| PUT | `/chatroom/messages/:id` | Edit message text |
| DELETE | `/chatroom/messages/:id` | Delete message |
| POST | `/chatroom/messages/:id/pin` | Toggle pin |
| POST | `/chatroom/messages/:id/react` | Toggle emoji reaction |
| POST | `/chatroom/:id/read` | Batch mark as read (body: `{ upToSequence? }`) |
| POST | `/chatroom/messages/:id/delivered` | Mark single message delivered |

### Direct Messages
| Method | Path | Description |
|--------|------|-------------|
| POST | `/dm/start` | Start or retrieve DM conversation (`{ targetUserId }`) |
| GET | `/dm` | List all DM conversations |
| GET | `/dm/:id/messages` | Get DM message history |

### Files & Presence
| Method | Path | Description |
|--------|------|-------------|
| POST | `/upload` | Multipart upload → `{ url, fileName, mimeType, fileSize }` |
| PUT | `/presence` | Update `{ presenceStatus, presenceNote }` |

### AI
| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/ai/:chatroomId/summarize` | `{ limit? }` | Bullet-point summary of last N messages |
| POST | `/ai/:chatroomId/suggest-reply` | — | Array of 3 reply suggestions |
| POST | `/ai/tone` | `{ message }` | `{ tone, suggestion }` — tone label + softened version |

### Analytics
| Method | Path | Description |
|--------|------|-------------|
| GET | `/analytics/metrics` | Live p50/p95/p99 latency, delivery rate, concurrency |

---

## Socket.IO Events

### Client → Server

| Event | Payload | Notes |
|-------|---------|-------|
| `chatroomMessage` | `{ chatroomId, message, clientMessageId, replyTo?, expiresIn? }` | Supports ACK callback `(ack) => {}` |
| `chatroomFileMessage` | `{ chatroomId, type, fileUrl, fileName, mimeType, fileSize, lat?, lng?, clientMessageId? }` | |
| `markRead` | `{ chatroomId, upToSequence? }` | Batch read receipt |
| `messageDelivered` | `{ messageId, chatroomId }` | Per-message delivery receipt |
| `syncOfflineQueue` | `{ messages[] }` | Drain IndexedDB queue on reconnect |
| `heartbeat` | — | Presence keepalive — sent every 25 s |
| `typing` / `stopTyping` | `{ chatroomId }` | TTL-managed on server |
| `presenceUpdate` | `{ presenceStatus, presenceNote }` | Broadcasts updated online list |
| `joinRoom` / `leaveRoom` | `{ chatroomId }` | Socket.IO room membership |
| `joinDM` / `leaveDM` | `{ conversationId }` | DM room membership |
| `directMessage` | `{ conversationId, message }` | |
| `dmTyping` / `dmStopTyping` | `{ conversationId }` | |
| `reactionToggled` | `{ chatroomId, messageId, reactions }` | Relay to room |
| `messageEdited` | `{ chatroomId, messageId, newText }` | Relay to room |
| `messageDeleted` | `{ chatroomId, messageId }` | Relay to room |
| `messagePinned` | `{ chatroomId, messageId, pinned }` | Relay to room |

### Server → Client

| Event | Payload | Description |
|-------|---------|-------------|
| `newMessage` | Full message + `sequenceNumber`, `deliveryStatus`, `clientMessageId` | Broadcast to room |
| `messagesRead` | `{ userId, chatroomId, upToSequence, readAt }` | Read receipt broadcast |
| `messageDeliveryUpdate` | `{ messageId, deliveredTo[] }` | Delivery receipt broadcast |
| `onlineUsers` | `[{ userId, name, dp, presenceStatus, presenceNote }]` | Full list refresh |
| `userTyping` / `userStopTyping` | `{ userId, name, chatroomId }` | Typing state (auto-expired after 4 s) |
| `userJoined` / `userLeft` | `{ userId, name }` | Room membership events |
| `heartbeatAck` | `{ ts }` | Timestamp echo |
| `messageError` | `{ error, message }` | Send failure |
| `syncOfflineQueueResult` | `{ results[] }` | Per-item `{ clientMessageId, messageId?, ok?, duplicate?, error? }` |
| `newDirectMessage` | `{ conversationId, ...message }` | DM broadcast |
| `dmNotification` | `{ conversationId, from, message }` | Cross-room DM alert |
| `dmUserTyping` / `dmUserStopTyping` | `{ userId, name? }` | DM typing |
| `reactionUpdated` | `{ messageId, reactions }` | Reaction relay |
| `messageEdited` | `{ messageId, newText }` | Edit relay |
| `messageDeleted` | `{ messageId }` | Delete relay |
| `messagePinned` | `{ messageId, pinned }` | Pin relay |

---

## Environment Variables

### Backend (`chat-back/.env`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DATABASE` | Yes | — | MongoDB URI |
| `SECRET` | Yes | — | JWT signing secret |
| `PORT` | No | `8000` | HTTP port |
| `ENV` | No | `production` | `DEVELOPMENT` enables full error stack in responses |
| `ANTHROPIC_API_KEY` | No | — | Enables `/ai/*` routes; omit to disable gracefully |
| `FRONTEND_URL` | No | — | Extra CORS origin (production domain) |

### Frontend (`chat-front/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `REACT_APP_API_URL` | Yes | Backend base URL — used for both REST and Socket.IO |

---

## Production Upgrade Path

Every in-process module in `chat-back/shared/` is a drop-in swap:

| Current | Production | Notes |
|---------|-----------|-------|
| `MessageDeduplicator` (JS Map, single node) | Redis `SET clientId serverId EX 600 NX` | Atomic, shared across all nodes |
| `SequenceCounter` (JS Map, single node) | Redis `INCR {room}:seq` | Atomic increment, no lock needed |
| `RateLimiter` (token bucket, JS) | Redis `DECRBY` + `EXPIRE` sliding window | Shared across nodes, ms precision |
| `PresenceHeartbeat` (setInterval) | Redis key `EXPIRE 60`, refreshed on heartbeat | Works across nodes; TTL on key = auto-offline |
| `MetricsCollector` (in-process Map) | Prometheus `/metrics` endpoint → Grafana; or Kafka → ClickHouse | Time-series, multi-instance aggregation |
| Socket.IO single-node pub/sub | `@socket.io/redis-adapter` + Redis pub/sub | Enables horizontal scaling with sticky sessions or consistent hashing |
| File uploads (local disk) | `multer-s3` → AWS S3 or GCS | Update `upload.js` storage engine; serve via CDN |
| MongoDB single-node | MongoDB Atlas multi-region + read replicas | Change URI; Mongoose handles the rest |

### Scaling milestones

| Users | Change |
|-------|--------|
| < 1 K | Current setup is sufficient |
| 1 K – 10 K | Add Redis for dedup/rate-limit/presence; `socket.io-redis` adapter |
| 10 K – 100 K | Horizontal Socket.IO pods behind a load balancer; sticky sessions |
| 100 K+ | Kafka message pipeline; separate presence microservice; read replicas |

---

## License

MIT
