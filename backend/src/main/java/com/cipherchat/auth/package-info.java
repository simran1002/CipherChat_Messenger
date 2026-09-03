/**
 * Auth module — registration, login, JWT access tokens, rotating refresh
 * tokens (one row = one live session), TOTP two-factor, and the Spring
 * Security configuration that guards HTTP and WebSocket. Depends on the user
 * module for identities; nothing depends on auth except through the security
 * principal in {@code shared}.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Auth", allowedDependencies = "user")
package com.cipherchat.auth;
