/**
 * User module — identity, profile, presence status text, and the public
 * {@code UserDirectory} other modules use to resolve display names. Owns the
 * {@code users} table; nothing else writes to it.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Users")
package com.cipherchat.user;
