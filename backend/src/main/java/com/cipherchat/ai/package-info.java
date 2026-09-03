/**
 * AI module — summaries, reply suggestions and tone checks for <em>rooms</em>
 * (server-readable by design). DMs never reach this module: their content is
 * end-to-end encrypted and the server has nothing to send. The upstream call
 * sits behind a circuit breaker so an LLM outage degrades to a 503 on three
 * endpoints instead of tying up request threads.
 */
@org.springframework.modulith.ApplicationModule(displayName = "AI assist", allowedDependencies = "chatroom")
package com.cipherchat.ai;
