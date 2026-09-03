/**
 * Chatroom module — server-readable team rooms: membership + roles, the
 * exactly-once message pipeline (dedup → sequence → persist → event),
 * reactions, pins, read/delivery receipts, unread watermarks, cursor history,
 * full-text search. Publishes {@code MessageSent / MessageRead /
 * MessageDelivered}; the WebSocket fan-out lives in the messaging gateway.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Chatrooms", allowedDependencies = "user")
package com.cipherchat.chatroom;
