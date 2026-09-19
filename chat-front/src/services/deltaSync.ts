/**
 * Sequence-based delta sync over CBOR.
 *
 * On reconnect the client says "this is the last sequence I hold per room" and receives only what
 * came after, in one round trip, as CBOR (about a fifth smaller than the same JSON; the larger
 * saving is not re-downloading history at all). JSON remains the fallback when the server or an
 * intermediary does not answer in CBOR.
 *
 * Wire shape (short keys on purpose — they repeat per row):
 *   request  { rooms: { [roomId]: lastSeq }, maxPerRoom? }
 *   response { rooms: [ { room, msgs: [ {s,i,u,n,t,k,b,r,e,c} ], w, m, d } ] }
 */
import { decode } from "cbor-x";
import api from "./api";

export interface DeltaMessage {
  sequenceNumber: number;
  id: string;
  userId: string;
  name: string;
  createdAt: string;
  type: string;
  message: string;
  replyToId: number | null;
  edited: boolean;
  clientMessageId: string | null;
}

export interface RoomDelta {
  roomId: string;
  messages: DeltaMessage[];
  /** The room's highest sequence at the time of the sync. */
  watermark: number;
  /** More messages remain after this page — call again from the new cursor. */
  more: boolean;
  /** The caller can no longer read this room. */
  denied: boolean;
}

interface WireMessage {
  s: number; i: number; u: string; n: string; t: number; k: string; b: string | null;
  r: number | null; e: boolean; c: string | null;
}
interface WireRoom { room: string; msgs: WireMessage[]; w: number; m: boolean; d: boolean }
interface WireResponse { rooms: WireRoom[] }

const CBOR = "application/cbor";

export function fromWire(wire: WireResponse): RoomDelta[] {
  return (wire.rooms ?? []).map((r) => ({
    roomId: r.room,
    watermark: Number(r.w ?? 0),
    more: Boolean(r.m),
    denied: Boolean(r.d),
    messages: (r.msgs ?? []).map((m) => ({
      sequenceNumber: Number(m.s),
      id: String(m.i),
      userId: m.u,
      name: m.n ?? "",
      createdAt: new Date(Number(m.t)).toISOString(),
      type: m.k,
      message: m.b ?? "",
      replyToId: m.r ?? null,
      edited: Boolean(m.e),
      clientMessageId: m.c ?? null,
    })),
  }));
}

/** Decode a sync response body by its content type. Exported for tests. */
export function decodeSyncBody(body: ArrayBuffer, contentType: string | undefined): RoomDelta[] {
  const bytes = new Uint8Array(body);
  if ((contentType ?? "").includes(CBOR)) {
    return fromWire(decode(bytes) as WireResponse);
  }
  return fromWire(JSON.parse(new TextDecoder().decode(bytes)) as WireResponse);
}

/** One sync round trip. `cursors` maps roomId → last sequence held (0 for none). */
export async function syncRooms(cursors: Record<string, number>, maxPerRoom = 200): Promise<RoomDelta[]> {
  if (Object.keys(cursors).length === 0) return [];
  const res = await api.post<ArrayBuffer>(
    "/api/v1/sync/rooms",
    { rooms: cursors, maxPerRoom },
    { responseType: "arraybuffer", headers: { Accept: `${CBOR}, application/json;q=0.5` } }
  );
  const contentType = String((res.headers as Record<string, unknown>)["content-type"] ?? "");
  return decodeSyncBody(res.data, contentType);
}

/**
 * Catch one room up completely: follows the `more` flag until the watermark is reached.
 * Bounded (maxPages) so a pathological server response cannot loop forever.
 */
export async function catchUpRoom(roomId: string, lastSeq: number, maxPages = 20): Promise<RoomDelta> {
  const all: DeltaMessage[] = [];
  let cursor = lastSeq;
  let last: RoomDelta = { roomId, messages: [], watermark: lastSeq, more: false, denied: false };
  for (let page = 0; page < maxPages; page++) {
    const [delta] = await syncRooms({ [roomId]: cursor });
    if (!delta) break;
    last = delta;
    if (delta.denied) break;
    all.push(...delta.messages);
    const tail = delta.messages[delta.messages.length - 1];
    if (!delta.more || !tail) break;
    cursor = tail.sequenceNumber;
  }
  return { ...last, messages: all };
}
