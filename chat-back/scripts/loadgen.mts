/**
 * Minimal hot-room load generator for A/B-testing the message send path.
 * N users in ONE room (worst-case fan-out), each pacing sends at the token
 * bucket's refill rate; measures ACK round-trip percentiles.
 *
 *   npx tsx scripts/loadgen.mts            # BASE_URL=http://localhost:8100
 *   USERS=40 SECONDS=45 npx tsx scripts/loadgen.mts
 */
import { io, type Socket } from "socket.io-client";

const BASE = process.env.BASE_URL ?? "http://localhost:8100";
const USERS = parseInt(process.env.USERS ?? "40", 10);
const SECONDS = parseInt(process.env.SECONDS ?? "45", 10);
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "500", 10);

async function j<T>(path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(BASE + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${(await res.text()).slice(0, 100)}`);
  return res.json() as Promise<T>;
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const stamp = Date.now();
const tokens: string[] = [];
for (let i = 0; i < USERS; i++) {
  const reg = await j<{ token: string }>("/user/register", {
    name: `loadgen ${i}`,
    email: `loadgen-${stamp}-${i}@test.cipher`,
    password: "password123",
  });
  tokens.push(reg.token);
}
const room = await j<{ chatroom: { _id: string } }>("/chatroom", { name: `LoadGen-${stamp}` }, tokens[0]);
const chatroomId = room.chatroom._id;

const rtts: number[] = [];
let sent = 0, acked = 0, failed = 0, rateLimited = 0;

const sockets: Socket[] = await Promise.all(
  tokens.map(
    (token) =>
      new Promise<Socket>((resolve, reject) => {
        const s = io(BASE, { auth: { token }, transports: ["websocket"], reconnection: true });
        s.once("connect", () => {
          s.emit("joinRoom", { chatroomId });
          resolve(s);
        });
        s.once("connect_error", reject);
      })
  )
);

console.log(`→ ${USERS} users, 1 room, ${SECONDS}s @ ${1000 / INTERVAL_MS}/s each (${BASE})`);

await new Promise<void>((done) => {
  const timers = sockets.map((s, idx) =>
    setInterval(() => {
      const t0 = Date.now();
      sent++;
      s.timeout(10_000).emit(
        "chatroomMessage",
        { chatroomId, message: `load ${idx}-${t0}`, clientMessageId: `lg-${stamp}-${idx}-${t0}-${Math.random()}` },
        (err: Error | null, ack?: { ok?: boolean; error?: string }) => {
          if (err || !ack) failed++;
          else if (ack.ok) { acked++; rtts.push(Date.now() - t0); }
          else if (ack.error === "rate_limited") rateLimited++;
          else failed++;
        }
      );
    }, INTERVAL_MS)
  );
  setTimeout(() => {
    timers.forEach(clearInterval);
    setTimeout(done, 3_000); // let in-flight acks land
  }, SECONDS * 1000);
});

sockets.forEach((s) => s.disconnect());
rtts.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    sent, acked, failed, rateLimited,
    throughputAckedPerSec: +(acked / SECONDS).toFixed(1),
    ackRttMs: { p50: pct(rtts, 50), p95: pct(rtts, 95), p99: pct(rtts, 99), max: rtts[rtts.length - 1] ?? 0 },
  })
);
process.exit(0);
