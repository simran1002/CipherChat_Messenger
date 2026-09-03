/**
 * Direct-message module — two-party conversations whose content is
 * end-to-end encrypted. The server validates envelope <em>structure</em>,
 * enforces the (sender, session, counter) replay backstop, deduplicates
 * client retries, and paginates history; it can never read a message. Legacy
 * plaintext rows from before E2EE remain readable and clearly typed.
 */
@org.springframework.modulith.ApplicationModule(displayName = "Direct messages", allowedDependencies = "user")
package com.cipherchat.dm;
