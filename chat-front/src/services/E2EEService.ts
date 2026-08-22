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
import { computeSafetyNumber, formatSafetyNumber } from "../crypto/safetyNumber";
import { createAndPublishIdentity, generateRecoveryCode, restoreFromBackup, uploadBackup } from "../crypto/identity";
import type { StoredIdentity, StoredSession } from "../crypto/keyStore";

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
        const server = await api.get<{ keys: { identityEd25519: string } | null }>("/keys/me");
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

      const server = await api.get<{ keys: unknown | null }>("/keys/me");
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
  async encrypt(conversationId: string, peerId: string, text: string): Promise<WireEnvelope> {
    const identity = this.requireIdentity();

    return keyStore.withLock(conversationId, async () => {
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
    envelope: WireEnvelope,
    opts: { own: boolean }
  ): Promise<DecryptResult> {
    const identity = this.identity ?? (await keyStore.loadIdentity());
    if (!identity) return { ok: false, text: UNDECRYPTABLE };
    this.identity = identity;

    try {
      let session = await keyStore.loadSession(envelope.sessionId);
      let keyChanged = false;

      if (!session && !opts.own && envelope.init) {
        // First envelope of a session initiated by the peer
        keyChanged = await this.checkPeerIdentity(senderId, envelope.init.ik);
        session = acceptSession(conversationId, senderId, envelope.sessionId, identity, envelope.init);
        await keyStore.saveSession(session);
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
    const payload = JSON.parse(atob(token.split(".")[1]!)) as { id: string };
    return payload.id;
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
    const res = await api.get<{ keys: PeerBundle & { keyVersion: number } }>(`/keys/${peerId}`);
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
        `/keys/${peerId}`
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
