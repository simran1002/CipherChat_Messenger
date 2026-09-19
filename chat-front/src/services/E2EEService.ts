/**
 * E2EE orchestrator — the ONLY module pages import for encryption.
 * Module singleton (house pattern, like NotificationService).
 *
 * Responsibilities: identity lifecycle state machine, session selection +
 * rotation, counter reservation under a cross-tab lock, decrypt with
 * per-session in-memory chain caching, TOFU pinning + key-change detection,
 * encrypted preview cache.
 */
import api from "./api";
import * as keyStore from "../crypto/keyStore";
import {
  acceptSession,
  initiateSession,
  needsRotation,
  type PeerBundle,
} from "../crypto/session";
import { open, openOwn, seal, type WireEnvelope } from "../crypto/envelope";
import { openV2, sealV2, startInitiator, startResponder, type WireEnvelopeV2 } from "../crypto/envelopeV2";
import * as vault from "../crypto/vault";
import { shredConversationIndex } from "../search/searchClient";
import { computeSafetyNumber, formatSafetyNumber } from "../crypto/safetyNumber";
import {
  createAndPublishIdentity,
  generateRecoveryCode,
  refreshBackup,
  restoreFromBackup,
  uploadBackup,
} from "../crypto/identity";
import type { StoredIdentity, StoredSession } from "../crypto/keyStore";
import { wipeSearchIndex } from "../search/searchClient";

export type E2EEStatus =
  | { state: "ready"; identity: StoredIdentity }
  | { state: "needs-setup" } // no local keys, none published — fresh account
  | { state: "needs-restore-or-reset" } // no local keys, but server has a published identity
  | { state: "unavailable"; reason: string };

export interface DecryptResult {
  ok: boolean;
  text: string; // plaintext, or a placeholder when !ok
  keyChanged?: boolean; // TOFU pin mismatch detected during this decrypt
}

const UNDECRYPTABLE = "⚠ Unable to decrypt — sent with a previous encryption key";
const UNDECRYPTABLE_V2 = "⚠ Not stored on this device — forward-secret messages cannot be re-opened from the server";

/** Either wire format; decrypt() dispatches on `v`. */
export type AnyEnvelope = WireEnvelope | WireEnvelopeV2;

const V2_FLAG = "CC_E2EE_V2";

class E2EEService {
  private identity: StoredIdentity | null = null;
  private status: E2EEStatus | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Resolve the identity state machine. Cached; call refresh() to re-check. */
  async ensureReady(): Promise<E2EEStatus> {
    if (this.status?.state === "ready") return this.status;
    try {
      const local = await keyStore.loadIdentity();
      if (local) {
        // Detect a reset made from another browser: server identity differs
        const server = await api.get<{ keys: { identityEd25519: string } | null }>("/api/v1/keys/me");
        if (server.data.keys && server.data.keys.identityEd25519 !== local.edPub) {
          this.status = { state: "needs-restore-or-reset" };
          return this.status;
        }
        if (!server.data.keys) {
          // We hold keys the server lost (or never got) — republish
          await createAndPublishIdentityFromLocal(local);
        }
        this.identity = local;
        this.status = { state: "ready", identity: local };
        return this.status;
      }

      const server = await api.get<{ keys: unknown | null }>("/api/v1/keys/me");
      this.status = server.data.keys ? { state: "needs-restore-or-reset" } : { state: "needs-setup" };
      return this.status;
    } catch (err) {
      this.status = {
        state: "unavailable",
        reason: err instanceof Error ? err.message : "E2EE unavailable",
      };
      return this.status;
    }
  }

  refresh(): void {
    this.status = null;
    this.identity = null;
  }

  /** Fresh account: generate, publish, back up. Returns the one-time recovery code. */
  async setUp(): Promise<string> {
    const identity = await createAndPublishIdentity();
    const code = generateRecoveryCode();
    await uploadBackup(code);
    this.identity = identity;
    this.status = { state: "ready", identity };
    return code;
  }

  /** New browser: restore identity + sessions from the recovery-code backup. */
  async restore(code: string): Promise<void> {
    const identity = await restoreFromBackup(code);
    this.identity = identity;
    this.status = { state: "ready", identity };
  }

  /** Nuclear option: new identity; peers will see a safety-number change. */
  async reset(): Promise<string> {
    await keyStore.wipeKeyStore();
    // The on-device search index holds decrypted text: a key reset must take it (and its key) with it.
    await wipeSearchIndex();
    await vault.wipeVault();
    this.refresh();
    return this.setUp();
  }

  // ── Sending ─────────────────────────────────────────────────────────────────

  /**
   * Encrypt `text` for a conversation. Reserves the counter and persists the
   * session BEFORE returning (under a cross-tab lock), so a crash after this
   * call burns a counter rather than reusing one — the invariant that makes
   * nonce reuse impossible.
   */
  async encrypt(conversationId: string, peerId: string, text: string): Promise<AnyEnvelope> {
    const identity = this.requireIdentity();

    return keyStore.withLock(conversationId, async () => {
      // v2 (Double Ratchet) when this conversation already runs on it — the peer may have started
      // it — or when this device opted in for new sessions. Otherwise the v1 chain sessions.
      const ratchet = await vault.latestRatchet(conversationId);
      if (ratchet || this.doubleRatchetEnabled()) {
        const session = ratchet ?? startInitiator(conversationId, peerId, identity, await this.fetchAndPinBundle(peerId));
        const me = this.myUserId();
        const { envelope, next } = sealV2(session, me, text);
        // Ratchet advance and our own plaintext commit together, BEFORE the ciphertext exists
        // outside this function: the sender can never re-derive this message key.
        await vault.commit(conversationId, next, { key: vault.messageKey(next.sessionId, me, envelope.ctr), text });
        return envelope;
      }
      let session = await this.activeSession(conversationId);
      let init: WireEnvelope["init"] | undefined;

      if (!session || needsRotation(session)) {
        if (session) {
          session.retiredAt = Date.now();
          await keyStore.saveSession(session);
        }
        const bundle = await this.fetchAndPinBundle(peerId);
        const initiated = initiateSession(conversationId, peerId, identity, bundle);
        session = initiated.session;
        init = initiated.init;
      }

      const ctr = session.sendCtr;
      session.sendCtr = ctr + 1;
      await keyStore.saveSession(session); // counter burned before ciphertext exists
      // New session → fold it into the server-side backup so a future restore
      // can decrypt this conversation. After saveSession so the refresh sees
      // it; fire-and-forget — the next session event retries on failure.
      if (init !== undefined) void refreshBackup().catch(() => {});

      // init must ride along until the peer has surely seen it: attach on
      // every message of the first ratchet turn (ctr 0). Later counters omit it.
      const envelope = seal(session, conversationId, this.myUserId(), ctr, text, init);
      if (init && ctr > 0) envelope.init = init;
      return envelope;
    });
  }

  // ── Receiving / history ────────────────────────────────────────────────────

  async decrypt(
    conversationId: string,
    senderId: string,
    envelope: AnyEnvelope,
    opts: { own: boolean }
  ): Promise<DecryptResult> {
    const identity = this.identity ?? (await keyStore.loadIdentity());
    if (!identity) return { ok: false, text: UNDECRYPTABLE };
    this.identity = identity;
    if (envelope.v === 2) return this.decryptV2(conversationId, senderId, envelope, opts, identity);

    try {
      let session = await keyStore.loadSession(envelope.sessionId);
      let keyChanged = false;

      if (!session && !opts.own && envelope.init) {
        // First envelope of a session initiated by the peer
        keyChanged = await this.checkPeerIdentity(senderId, envelope.init.ik);
        session = acceptSession(conversationId, senderId, envelope.sessionId, identity, envelope.init);
        await keyStore.saveSession(session);
        void refreshBackup().catch(() => {});
      }
      if (!session) return { ok: false, text: UNDECRYPTABLE };

      const text = opts.own
        ? openOwn(session, conversationId, senderId, envelope)
        : open(session, conversationId, senderId, envelope);

      if (!opts.own && envelope.ctr > session.peerMaxCtr) {
        session.peerMaxCtr = envelope.ctr;
        await keyStore.saveSession(session);
      }

      return { ok: true, text, keyChanged };
    } catch {
      return { ok: false, text: UNDECRYPTABLE };
    }
  }

  /**
   * v2: the vault is the source of truth for anything already seen (history, our own messages,
   * another tab's work); only a never-seen peer message touches the ratchet, under the cross-tab
   * lock, and the advanced state is committed together with the plaintext it produced.
   */
  private async decryptV2(
    conversationId: string,
    senderId: string,
    envelope: WireEnvelopeV2,
    opts: { own: boolean },
    identity: StoredIdentity
  ): Promise<DecryptResult> {
    const key = vault.messageKey(envelope.sessionId, senderId, envelope.ctr);
    try {
      const stored = await vault.loadMessage(conversationId, key);
      if (stored !== null) return { ok: true, text: stored };
      if (opts.own) return { ok: false, text: UNDECRYPTABLE_V2 };
      return await keyStore.withLock(conversationId, async () => {
        const again = await vault.loadMessage(conversationId, key);
        if (again !== null) return { ok: true, text: again };
        let session = await vault.loadRatchet(conversationId, envelope.sessionId);
        let keyChanged = false;
        if (!session) {
          if (!envelope.init) return { ok: false, text: UNDECRYPTABLE_V2 };
          keyChanged = await this.checkPeerIdentity(senderId, envelope.init.ik);
          session = startResponder(conversationId, senderId, envelope.sessionId, identity, envelope.init);
        }
        const { text, next } = openV2(session, senderId, envelope);
        await vault.commit(conversationId, next, { key, text });
        return { ok: true, text, keyChanged };
      });
    } catch {
      return { ok: false, text: UNDECRYPTABLE_V2 };
    }
  }

  // ── Double Ratchet opt-in and cryptographic shredding ─────────────────────
  doubleRatchetEnabled(): boolean {
    try {
      return localStorage.getItem(V2_FLAG) === "1";
    } catch {
      return false;
    }
  }

  /** New sessions this device STARTS use the Double Ratchet; existing sessions keep their protocol. */
  setDoubleRatchetEnabled(on: boolean): void {
    try {
      if (on) localStorage.setItem(V2_FLAG, "1");
      else localStorage.removeItem(V2_FLAG);
    } catch {
      // storage blocked: stays off
    }
  }

  /** Does this conversation currently run on the Double Ratchet on this device? */
  async usesDoubleRatchet(conversationId: string): Promise<boolean> {
    return (await vault.latestRatchet(conversationId)) !== null;
  }

  /**
   * Cryptographic shredding of one conversation ON THIS DEVICE: the conversation key (and with it
   * the sealed history and ratchet), the v1 sessions, the preview and the search snapshot. For v2
   * traffic the server's ciphertext is already unopenable (message keys were destroyed on use);
   * v1 ciphertext becomes unopenable here because its session keys are gone. The peer's copy is
   * the peer's: shredding is a local guarantee, not a remote wipe.
   */
  async shredConversation(conversationId: string): Promise<{ sealedRows: number; v1Sessions: number }> {
    return keyStore.withLock(conversationId, async () => {
      const sealedRows = await vault.shredConversation(conversationId);
      const v1Sessions = await keyStore.deleteConversationData(conversationId);
      await shredConversationIndex(conversationId);
      void refreshBackup().catch(() => {}); // the server-side backup must forget the v1 sessions too
      return { sealedRows, v1Sessions };
    });
  }

  // ── Safety numbers / pins ──────────────────────────────────────────────────

  async safetyNumberFor(peerId: string): Promise<{ digits: string; formatted: string; verified: boolean } | null> {
    const identity = this.identity ?? (await keyStore.loadIdentity());
    if (!identity) return null;
    const pin = await keyStore.getPeerPin(peerId);
    const peerKey = pin?.identityEd25519 ?? (await this.fetchAndPinBundle(peerId)).identityEd25519;
    const digits = computeSafetyNumber(this.myUserId(), identity.edPub, peerId, peerKey);
    const freshPin = pin ?? (await keyStore.getPeerPin(peerId));
    return { digits, formatted: formatSafetyNumber(digits), verified: freshPin?.verified ?? false };
  }

  async markVerified(peerId: string): Promise<void> {
    const pin = await keyStore.getPeerPin(peerId);
    // Never succeed silently: a "Verified" badge must always be backed by a
    // persisted pin (safetyNumberFor() pins on first view, so this only
    // fires if the modal is driven out of order).
    if (!pin) throw new Error("No pinned identity for this contact yet — open the safety number first.");
    await keyStore.savePeerPin({ ...pin, verified: true });
  }

  // ── Preview cache ──────────────────────────────────────────────────────────

  async cachePreview(conversationId: string, text: string): Promise<void> {
    await keyStore.savePreview(conversationId, { text: text.slice(0, 80), at: Date.now() });
  }

  async getPreview(conversationId: string): Promise<string | null> {
    const cached = await keyStore.loadPreview(conversationId);
    return cached?.text ?? null;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private requireIdentity(): StoredIdentity {
    if (!this.identity) throw new Error("E2EE not ready — call ensureReady() first");
    return this.identity;
  }

  private myUserId(): string {
    const token = localStorage.getItem("CC_Token");
    if (!token) throw new Error("Not authenticated");
    // The Java backend's access token carries the user id in the standard
    // `sub` claim (JwtService.issueAccessToken), not a custom `id` claim.
    const payload = JSON.parse(atob(token.split(".")[1]!)) as { sub: string };
    return payload.sub;
  }

  private async activeSession(conversationId: string): Promise<StoredSession | null> {
    const sessions = await keyStore.loadConversationSessions(conversationId);
    const mine = sessions
      .filter((s) => !s.retiredAt && s.role === "init")
      .sort((a, b) => b.createdAt - a.createdAt);
    // Prefer our latest initiated session; else send on the peer's session
    const usable = mine[0] ?? sessions.filter((s) => !s.retiredAt).sort((a, b) => b.createdAt - a.createdAt)[0];
    return usable ?? null;
  }

  /** Fetch a peer bundle, TOFU-pin the identity, flag changes. */
  private async fetchAndPinBundle(peerId: string): Promise<PeerBundle> {
    const res = await api.get<{ keys: PeerBundle & { keyVersion: number } }>(`/api/v1/keys/${peerId}`);
    const bundle = res.data.keys;
    await this.checkPeerIdentity(peerId, undefined, bundle.identityEd25519, bundle.keyVersion);
    return bundle;
  }

  /**
   * TOFU: pin on first sight; report (never block) on change.
   * Returns true when the pinned identity CHANGED.
   */
  private async checkPeerIdentity(
    peerId: string,
    claimedX25519?: string,
    directoryEd25519?: string,
    keyVersion = 1
  ): Promise<boolean> {
    let ed = directoryEd25519;
    if (!ed) {
      const res = await api.get<{ keys: { identityEd25519: string; identityX25519: string; keyVersion: number } }>(
        `/api/v1/keys/${peerId}`
      );
      ed = res.data.keys.identityEd25519;
      keyVersion = res.data.keys.keyVersion;
      // Envelope's claimed initiator key must match the directory
      if (claimedX25519 && res.data.keys.identityX25519 !== claimedX25519) {
        // Mismatch between envelope and directory — treat as key change signal
        await keyStore.savePeerPin({
          userId: peerId,
          identityEd25519: ed,
          keyVersion,
          verified: false,
          pinnedAt: Date.now(),
        });
        return true;
      }
    }

    const pin = await keyStore.getPeerPin(peerId);
    if (!pin) {
      await keyStore.savePeerPin({
        userId: peerId,
        identityEd25519: ed,
        keyVersion,
        verified: false,
        pinnedAt: Date.now(),
      });
      return false;
    }
    if (pin.identityEd25519 !== ed) {
      await keyStore.savePeerPin({
        userId: peerId,
        identityEd25519: ed,
        keyVersion,
        verified: false, // verification resets on key change
        pinnedAt: Date.now(),
      });
      return true;
    }
    return false;
  }
}

/** Republish helper for the "server lost our keys" edge. */
async function createAndPublishIdentityFromLocal(identity: StoredIdentity): Promise<void> {
  const { publishIdentity } = await import("../crypto/identity");
  await publishIdentity(identity);
}

const e2eeService = new E2EEService();
export default e2eeService;
