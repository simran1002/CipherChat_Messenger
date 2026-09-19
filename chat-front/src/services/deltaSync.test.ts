import { describe, expect, it } from "vitest";
import { encode } from "cbor-x";
import { decodeSyncBody, fromWire } from "./deltaSync";

const wire = {
  rooms: [
    {
      room: "11111111-1111-1111-1111-111111111111",
      msgs: [
        { s: 3, i: 41, u: "u-1", n: "Priya", t: 1789843146022, k: "text", b: "filing at 5", r: null, e: false, c: "c-1" },
        { s: 4, i: 42, u: "u-2", n: "Marcus", t: 1789843147022, k: "text", b: "ack", r: 41, e: true, c: null },
      ],
      w: 9,
      m: true,
      d: false,
    },
    { room: "22222222-2222-2222-2222-222222222222", msgs: [], w: 0, m: false, d: true },
  ],
};

function toArrayBuffer(bytes: ArrayLike<number>): ArrayBuffer {
  return Uint8Array.from(bytes).buffer as ArrayBuffer;
}

describe("deltaSync", () => {
  it("maps the short wire keys to message fields", () => {
    const [room, denied] = fromWire(wire);
    expect(room!.messages.map((m) => [m.sequenceNumber, m.message, m.replyToId, m.edited])).toEqual([
      [3, "filing at 5", null, false],
      [4, "ack", 41, true],
    ]);
    expect(room!.messages[0]!.createdAt).toBe(new Date(1789843146022).toISOString());
    expect(room).toMatchObject({ watermark: 9, more: true, denied: false });
    expect(denied).toMatchObject({ denied: true, messages: [] });
  });

  it("decodes CBOR and JSON bodies to the same result", () => {
    const fromCbor = decodeSyncBody(toArrayBuffer(encode(wire)), "application/cbor");
    const fromJson = decodeSyncBody(toArrayBuffer(new TextEncoder().encode(JSON.stringify(wire))), "application/json");
    expect(fromCbor).toEqual(fromJson);
  });

  it("CBOR is smaller than JSON for the same payload", () => {
    expect(encode(wire).byteLength).toBeLessThan(new TextEncoder().encode(JSON.stringify(wire)).byteLength);
  });

  it("falls back to JSON when the content type is missing", () => {
    const body = toArrayBuffer(new TextEncoder().encode(JSON.stringify(wire)));
    expect(decodeSyncBody(body, undefined)).toHaveLength(2);
  });
});
