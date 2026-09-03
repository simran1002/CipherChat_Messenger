/**
 * Shared kernel — the only package every application module may depend on.
 * Contains cross-cutting types with no business logic of their own: API
 * errors, the security principal, request correlation, Redis primitives,
 * Kafka failure policy, and the domain events that cross module boundaries
 * (and, externalized, land on Kafka).
 *
 * <p>Declared OPEN: every sub-package is public API by design, so modules may
 * reference {@code shared.events}, {@code shared.api} etc. directly without
 * enumerating named interfaces in their allow-lists.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Shared kernel",
        type = org.springframework.modulith.ApplicationModule.Type.OPEN)
@org.springframework.lang.NonNullApi
package com.cipherchat.shared;
