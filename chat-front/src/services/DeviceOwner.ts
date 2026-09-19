import * as keyStore from "../crypto/keyStore";
import * as vault from "../crypto/vault";
import { wipeSearchIndex } from "../search/searchClient";
import * as OfflineQueue from "./OfflineQueue";

/**
 * Keeps this browser's local E2EE data (identity, v1/v2 sessions, the decrypted-message vault, the
 * on-device search index, the offline queue) scoped to ONE account at a time.
 *
 * Every one of those stores lives in IndexedDB keyed only by conversation id, never by user id, because
 * on any given device there is normally only one signed-in account. Logging out used to clear just the
 * access token: a second account signing in on the same browser inherited the first account's identity,
 * decrypted message history and queued sends outright — E2EEService would silently republish account A's
 * keys as account B's, and anything still in the offline queue would be sent AS B.
 *
 * Call {@link claim} once, right after a login or registration succeeds and before anything touches the
 * socket, E2EE or the offline queue. It is a no-op for the same account signing back in — sessions, vault
 * history and the search index all survive a normal logout/login, which matters because vault plaintext
 * is the only surviving copy of a v2 (Double Ratchet) conversation's history (ADR-0011). Only an actual
 * account switch on this device pays the cost of a wipe.
 */
const OWNER_KEY = "CC_DeviceOwner";

export async function claim(userId: string): Promise<void> {
  const previous = localStorage.getItem(OWNER_KEY);
  if (previous === userId) return;

  if (previous !== null) {
    await Promise.all([
      keyStore.wipeKeyStore(),
      vault.wipeVault(),
      wipeSearchIndex(),
      OfflineQueue.clear(),
    ]);
  }
  localStorage.setItem(OWNER_KEY, userId);
}

/**
 * Logout deliberately does NOT clear the owner record: it does not know who signs in next, so it cannot
 * decide whether to wipe. {@link claim} makes that call on the FOLLOWING login by comparing the incoming
 * user id against the record left here — which is exactly why the record must survive logout.
 */
