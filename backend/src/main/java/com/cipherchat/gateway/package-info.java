/**
 * Real-time gateway — the STOMP-over-WebSocket edge. Authenticates the
 * socket at CONNECT with the same JWT the REST API uses, routes client frames
 * to the domain modules, and fans domain events out to subscribed sessions
 * on <em>every</em> instance via Redis pub/sub (the in-memory STOMP broker is
 * per-JVM; Redis makes N replicas behave as one broker).
 */
@org.springframework.modulith.ApplicationModule(displayName = "Gateway",
        allowedDependencies = {"chatroom", "user", "presence", "dm", "auth"})
package com.cipherchat.gateway;
