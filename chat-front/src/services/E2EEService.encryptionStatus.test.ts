import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSession } from "../crypto/keyStore";
import type { RatchetSession } from "../crypto/vault";
import { ROTATE_AFTER_MESSAGES, ROTATE_AFTER_MS } from "../crypto/session";

const latestRatchet = vi.fn<() => Promise<RatchetSession | null>>();
const loadConversationSessions = vi.fn<() => Promise<StoredSession[]>>();

vi.mock("../crypto/vault", () => ({ latestRatchet: () => latestRatchet() }));
vi.mock("../crypto/keyStore", () => ({ loadConversationSessions: () => loadConversationSessions() }));

const { default: e2eeService } = await import("./E2EEService");

const CONV = "11111111-1111-1111-1111-111111111111";

function ratchet(overrides: Partial<RatchetSession> = {}): RatchetSession {
  return {
    sessionId: "s1",
    conversationId: CONV,
    peerId: "peer",
    role: "init",
    createdAt: Date.now() - 1000,
    sendTotal: 7,
    peerReplied: true,
    state: {} as RatchetSession["state"],
    ...overrides,
  };
}

function v1Session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    sessionId: "s0",
    conversationId: CONV,
    peerId: "peer",
    role: "init",
    ckInit: "a",
    ckResp: "b",
    sendCtr: 3,
    peerMaxCtr: -1,
    createdAt: Date.now() - 1000,
    ...overrides,
  };
}

describe("E2EEService.encryptionStatus", () => {
  afterEach(() => vi.clearAllMocks());

  it("reports v2 (Double Ratchet) with the vault's own send count when a ratchet session exists", async () => {
    latestRatchet.mockResolvedValue(ratchet({ sendTotal: 42, createdAt: 1_000 }));

    const status = await e2eeService.encryptionStatus(CONV);

    expect(status).toEqual({ protocol: "v2", messagesSent: 42, since: 1_000 });
    // A v2 session answers the question without ever reading the v1 session store.
    expect(loadConversationSessions).not.toHaveBeenCalled();
  });

  it("reports v1 with rotation math when only a chain session exists", async () => {
    const since = Date.now() - 1_000; // recent: only the message count is under test here
    latestRatchet.mockResolvedValue(null);
    loadConversationSessions.mockResolvedValue([v1Session({ sendCtr: 150, createdAt: since })]);

    const status = await e2eeService.encryptionStatus(CONV);

    expect(status).toEqual({
      protocol: "v1",
      messagesSent: 150,
      since,
      rotatesAt: since + ROTATE_AFTER_MS,
      messagesUntilRotation: ROTATE_AFTER_MESSAGES - 150,
      needsRotation: false,
    });
  });

  it("flags needsRotation once the message-count bound is reached", async () => {
    const since = Date.now() - 1_000;
    latestRatchet.mockResolvedValue(null);
    loadConversationSessions.mockResolvedValue([v1Session({ sendCtr: ROTATE_AFTER_MESSAGES, createdAt: since })]);

    const status = await e2eeService.encryptionStatus(CONV);

    expect(status).toMatchObject({ protocol: "v1", needsRotation: true, messagesUntilRotation: 0 });
  });

  it("flags needsRotation once the 7-day age bound is reached, even with few messages", async () => {
    latestRatchet.mockResolvedValue(null);
    loadConversationSessions.mockResolvedValue([v1Session({ sendCtr: 2, createdAt: Date.now() - ROTATE_AFTER_MS - 1 })]);

    const status = await e2eeService.encryptionStatus(CONV);

    expect(status).toMatchObject({ protocol: "v1", needsRotation: true, messagesSent: 2 });
  });

  it("reports none when neither a v2 nor a v1 session exists", async () => {
    latestRatchet.mockResolvedValue(null);
    loadConversationSessions.mockResolvedValue([]);

    const status = await e2eeService.encryptionStatus(CONV);

    expect(status).toEqual({ protocol: "none" });
  });

  it("ignores a retired v1 session and falls back to none", async () => {
    latestRatchet.mockResolvedValue(null);
    loadConversationSessions.mockResolvedValue([v1Session({ retiredAt: Date.now() })]);

    const status = await e2eeService.encryptionStatus(CONV);

    expect(status).toEqual({ protocol: "none" });
  });
});
