import { describe, expect, it } from "vitest";
import {
  MAX_SKIP,
  RatchetError,
  expireSkipped,
  initInitiator,
  initResponder,
  ratchetDecrypt,
  ratchetEncrypt,
  type RatchetMessage,
  type RatchetState,
} from "./doubleRatchet";
import { generateX25519, randomBytes, utf8Encode } from "./primitives";

const AD = utf8Encode("conv-1|alice|bob");

function pair(): { alice: RatchetState; bob: RatchetState } {
  const sk = randomBytes(32);
  const bobSpk = generateX25519();
  return { alice: initInitiator(sk, bobSpk.publicKey), bob: initResponder(sk, bobSpk.privateKey, bobSpk.publicKey) };
}

/** Tiny harness: mutable parties so tests read like a conversation. */
class Party {
  constructor(public state: RatchetState) {}
  send(text: string): RatchetMessage {
    const { message, next } = ratchetEncrypt(this.state, text, AD);
    this.state = next;
    return message;
  }
  recv(m: RatchetMessage): string {
    const { plaintext, next } = ratchetDecrypt(this.state, m, AD);
    this.state = next;
    return plaintext;
  }
}

function parties(): { a: Party; b: Party } {
  const { alice, bob } = pair();
  return { a: new Party(alice), b: new Party(bob) };
}

describe("double ratchet", () => {
  it("delivers in order and ratchets the DH key on every change of direction", () => {
    const { a, b } = parties();
    const m1 = a.send("hello");
    expect(b.recv(m1)).toBe("hello");
    const m2 = b.send("hi alice");
    expect(a.recv(m2)).toBe("hi alice");
    const m3 = a.send("how are you");
    expect(b.recv(m3)).toBe("how are you");
    expect(m3.header.dh).not.toBe(m1.header.dh);      // Alice's ratchet key changed after hearing from Bob
    expect(m3.header.pn).toBe(1);                       // her previous chain held exactly one message
    expect(m3.header.n).toBe(0);
  });

  it("the responder cannot send before it has received", () => {
    const { b } = parties();
    expect(() => b.send("too early")).toThrowError(RatchetError);
  });

  it("handles out-of-order delivery inside one chain", () => {
    const { a, b } = parties();
    const [m0, m1, m2] = [a.send("zero"), a.send("one"), a.send("two")];
    expect(b.recv(m2)).toBe("two");
    expect(b.state.skipped).toHaveLength(2);
    expect(b.recv(m0)).toBe("zero");
    expect(b.recv(m1)).toBe("one");
    expect(b.state.skipped).toHaveLength(0);
  });

  it("handles a late message from the PREVIOUS chain after a DH ratchet step", () => {
    const { a, b } = parties();
    const early = a.send("early");            // chain 1, n=0
    const late = a.send("late, delayed");      // chain 1, n=1 — held back
    expect(b.recv(early)).toBe("early");
    expect(a.recv(b.send("reply"))).toBe("reply");
    const fresh = a.send("new chain");         // chain 2; header.pn = 2 tells Bob one key was skipped
    expect(b.recv(fresh)).toBe("new chain");
    expect(b.state.skipped).toHaveLength(1);
    expect(b.recv(late)).toBe("late, delayed");
  });

  it("forward secrecy: a consumed message key is gone — replaying the frame fails", () => {
    const { a, b } = parties();
    const m = a.send("once only");
    expect(b.recv(m)).toBe("once only");
    expect(() => b.recv(m)).toThrowError(/already used|authentication/);
  });

  it("a forged or corrupted frame never advances the receiver's state", () => {
    const { a, b } = parties();
    const good = a.send("real");
    const forged: RatchetMessage = { header: { ...good.header, n: 5 }, ciphertext: Uint8Array.from(good.ciphertext) };
    const before = JSON.stringify(b.state);
    expect(() => b.recv(forged)).toThrowError(RatchetError);
    const flipped: RatchetMessage = { header: good.header, ciphertext: Uint8Array.from(good.ciphertext) };
    flipped.ciphertext[0] = flipped.ciphertext[0]! ^ 0x01;
    expect(() => b.recv(flipped)).toThrowError(RatchetError);
    expect(JSON.stringify(b.state)).toBe(before);       // untouched: no skipped keys minted, no counters moved
    expect(b.recv(good)).toBe("real");                   // and the genuine message still opens
  });

  it("binds the associated data: a frame replayed into another conversation is rejected", () => {
    const { a, b } = parties();
    const m = a.send("context-bound");
    expect(() => ratchetDecrypt(b.state, m, utf8Encode("conv-2|alice|bob"))).toThrowError(RatchetError);
  });

  it("refuses to derive more than MAX_SKIP keys for one frame", () => {
    const { a, b } = parties();
    const first = a.send("first");
    const forgedGap: RatchetMessage = { header: { ...first.header, n: MAX_SKIP + 1 }, ciphertext: first.ciphertext };
    expect(() => b.recv(forgedGap)).toThrowError(/Refusing to skip/);
  });

  it("post-compromise security: a stolen state is locked out once the victim uses a ratchet key minted after the theft", () => {
    const { a, b } = parties();
    expect(b.recv(a.send("before the theft"))).toBe("before the theft");
    const thief = new Party(JSON.parse(JSON.stringify(b.state)) as RatchetState);

    // The copy includes Bob's CURRENT ratchet private key, so the thief follows one more step…
    expect(a.recv(b.send("bob replies with the key the thief also holds"))).toContain("thief also holds");
    const stillExposed = a.send("alice's new ratchet key, encrypted to Bob's old one");
    expect(thief.recv(stillExposed)).toContain("new ratchet key");
    expect(b.recv(stillExposed)).toContain("new ratchet key");   // Bob mints a FRESH key here; the thief's copy mints a different one

    // …and is locked out as soon as that fresh key is in use.
    expect(a.recv(b.send("sent under the fresh key"))).toBe("sent under the fresh key");
    const healed = a.send("healed");
    expect(b.recv(healed)).toBe("healed");
    expect(() => thief.recv(healed)).toThrowError(RatchetError);
  });

  it("survives serialisation between every step (state is plain data)", () => {
    const { a, b } = parties();
    const roundTrip = (p: Party) => (p.state = JSON.parse(JSON.stringify(p.state)) as RatchetState);
    for (let i = 0; i < 6; i++) {
      const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
      if (from === b && i === 1) expect(true).toBe(true);
      if (from.state.cks === null) continue;
      const m = from.send(`msg ${i}`);
      roundTrip(from);
      expect(to.recv(m)).toBe(`msg ${i}`);
      roundTrip(to);
    }
  });

  it("expires skipped keys by age", () => {
    const { a, b } = parties();
    a.send("lost forever");
    const second = a.send("arrives");
    const { next } = ratchetDecrypt(b.state, second, AD, 1_000);
    expect(next.skipped).toHaveLength(1);
    expect(expireSkipped(next, 500, 2_000).removed).toBe(1);
    expect(expireSkipped(next, 5_000, 2_000).removed).toBe(0);
  });

  it("long alternating conversation with random reordering stays consistent", () => {
    const { a, b } = parties();
    let sent = 0;
    for (let round = 0; round < 25; round++) {
      const [from, to] = round % 2 === 0 ? [a, b] : [b, a];
      const burst = [from.send(`r${round}-0`), from.send(`r${round}-1`), from.send(`r${round}-2`)];
      const order = round % 3 === 0 ? [2, 0, 1] : round % 3 === 1 ? [1, 2, 0] : [0, 1, 2];
      for (const i of order) {
        expect(to.recv(burst[i]!)).toBe(`r${round}-${i}`);
        sent++;
      }
    }
    expect(sent).toBe(75);
    expect(a.state.skipped).toHaveLength(0);
    expect(b.state.skipped).toHaveLength(0);
  });
});
