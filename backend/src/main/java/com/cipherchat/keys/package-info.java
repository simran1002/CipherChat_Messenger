/**
 * Keys module — the E2EE key directory. Stores each user's public identity
 * and signed prekey (verifying the prekey signature is the server's one and
 * only cryptographic duty) and the opaque, client-encrypted recovery backup.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Key directory", allowedDependencies = "user")
package com.cipherchat.keys;
