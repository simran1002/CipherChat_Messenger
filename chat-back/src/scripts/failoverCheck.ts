/**
 * Kill-a-pod failover verifier.
 *
 * Drives the scale-out stack (nginx LB → 2 backend replicas) the way the
 * interview demo does, but asserts the outcome instead of eyeballing it:
 *
 *   1. register two users, create a room, connect both over socket.io via the LB
 *   2. Alice sends TOTAL messages with ACKs (client-style retry on timeout)
 *   3. at message KILL_AT, `docker compose stop backend1` fires mid-stream
 *   4. assert: every message persisted exactly once, sequence numbers are
 *      gap-free and strictly increasing, and Bob received every message
 *      exactly once — across the failover
 *
 * Usage (stack already up):
 *   npx tsx src/scripts/failoverCheck.ts
 *   BASE_URL=http://localhost:8080 TOTAL=80 KILL_AT=40 npx tsx src/scripts/failoverCheck.ts
 *   NO_KILL=1 ...   (just measures the pipeline without stopping a pod)
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { io, type Socket } from "socket.io-client";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const TOTAL = parseInt(process.env.TOTAL ?? "60", 10);
const KILL_AT = parseInt(process.env.KILL_AT ?? String(Math.floor(TOTAL / 2)), 10);
const NO_KILL = process.env.NO_KILL === "1";
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? path.resolve(process.cwd(), "..", "docker-compose.scale.yml");
/**
 * Which replica to stop. "auto" (default) asks /health through the LB — with
 * ip_hash the HTTP request lands on the same pod as this client's sockets, so
 * /health's `pod` hostname IS the socket-owning replica. From a single machine
 * every connection shares one IP, so killing a hard-coded pod name usually
 * kills the *other* replica and proves nothing about socket failover.
 */
const POD_ENV = process.env.POD ?? "auto";
// Pace like a human, not a flood: the per-user token bucket is 20 burst /
// 2 per second (shared across replicas via Redis) — sending faster than the
// refill rate correctly trips rate_limited, which is not what this script
// is measuring. 500 ms ≈ the refill rate.
const SEND_INTERVAL_MS = parseInt(process.env.SEND_INTERVAL_MS ?? "500", 10);

interface Ack {
  ok: boolean;
  messageId?: string;
  sequenceNumber?: number;
  duplicate?: boolean;
  error?: string;
}

async function rest<T>(pathname: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${pathname} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

async function register(name: string): Promise<{ token: string; userId: string }> {
  const body = await rest<{ token: string; user: { id: string } }>("/user/register", {
    method: "POST",
    body: JSON.stringify({ name, email: `${name.toLowerCase()}-${Date.now()}@test.cipher`, password: "password123" }),
  });
  return { token: body.token, userId: body.user.id };
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(BASE_URL, {
      auth: { token },
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 250,
      reconnectionDelayMax: 2000,
    });
    s.once("connect", () => resolve(s));
    s.once("connect_error", reject);
  });
}

/** Client-style send: ack with timeout, retry on timeout with the SAME clientMessageId. */
async function sendWithRetry(
  socket: Socket,
  chatroomId: string,
  message: string,
  clientMessageId: string
): Promise<{ ack: Ack; attempts: number; ms: number }> {
  const start = Date.now();
  for (let attempt = 1; attempt <= 6; attempt++) {
    const ack = await new Promise<Ack | null>((resolve) => {
      socket
        .timeout(4000)
        .emit("chatroomMessage", { chatroomId, message, clientMessageId }, (err: Error | null, a?: Ack) =>
          resolve(err ? null : (a ?? null))
        );
    });
    if (ack && (ack.ok || ack.duplicate)) return { ack, attempts: attempt, ms: Date.now() - start };
    if (ack && !ack.ok && ack.error && ack.error !== "server_error") {
      throw new Error(`terminal ack error: ${ack.error}`);
    }
    await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  throw new Error(`no ack after retries for ${clientMessageId}`);
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!;
}

/** Resolve the compose service name that owns this client's connections. */
async function resolvePodToKill(): Promise<string> {
  if (POD_ENV !== "auto") return POD_ENV;
  const health = await rest<{ pod?: string }>("/health");
  const host = health.pod ?? "";
  // container hostname = container id prefix → map to the compose service name
  const names = execSync(`docker ps --no-trunc --format "{{.ID}} {{.Names}}"`, { encoding: "utf8" });
  const line = names.split("\n").find((l) => host && l.startsWith(host));
  const containerName = line?.split(" ")[1] ?? "";
  const m = containerName.match(/-(backend\d+)-\d+$/);
  if (!m) {
    console.log(`  ! could not map pod host "${host}" to a compose service — defaulting to backend1`);
    return "backend1";
  }
  return m[1]!;
}

async function main(): Promise<void> {
  const POD_TO_KILL = NO_KILL ? "-" : await resolvePodToKill();
  console.log(`→ target ${BASE_URL}, ${TOTAL} messages, ${NO_KILL ? "no kill" : `stop ${POD_TO_KILL} (socket owner) at #${KILL_AT}`}`);

  const alice = await register("Alice");
  const bob = await register("Bob");
  const room = await rest<{ chatroom: { _id: string } }>("/chatroom", {
    method: "POST",
    token: alice.token,
    body: JSON.stringify({ name: `Failover-${Date.now()}` }),
  });
  const chatroomId = room.chatroom._id;

  const aliceSock = await connect(alice.token);
  const bobSock = await connect(bob.token);

  const bobReceived = new Map<string, { text: string; seq: number }>(); // _id → msg
  let bobDuplicateEvents = 0;
  bobSock.on("newMessage", (m: { _id: string; message: string; sequenceNumber: number }) => {
    if (bobReceived.has(m._id)) bobDuplicateEvents++;
    bobReceived.set(m._id, { text: m.message, seq: m.sequenceNumber });
  });
  const reconnects = { alice: 0, bob: 0 };
  // Mirror the real client (App.tsx): socket.io does NOT auto-reconnect when
  // the SERVER initiated the disconnect (graceful shutdown sends exactly that),
  // so both sides must call connect() themselves; room membership is per
  // connection, so rejoin on every reconnect.
  for (const [who, sock] of [["alice", aliceSock], ["bob", bobSock]] as const) {
    sock.on("disconnect", (reason) => {
      if (reason === "io server disconnect") sock.connect();
    });
    sock.io.on("reconnect", () => {
      reconnects[who]++;
      sock.emit("joinRoom", { chatroomId });
    });
  }

  aliceSock.emit("joinRoom", { chatroomId });
  bobSock.emit("joinRoom", { chatroomId });
  await new Promise((r) => setTimeout(r, 300));

  const latencies: number[] = [];
  const retried: number[] = [];
  const serverIds = new Set<string>();
  let duplicatesAcked = 0;
  let killedAt: number | null = null;

  for (let i = 1; i <= TOTAL; i++) {
    if (!NO_KILL && i === KILL_AT) {
      console.log(`  ✂  stopping ${POD_TO_KILL} at message #${i}`);
      killedAt = Date.now();
      execSync(`docker compose -f "${COMPOSE_FILE}" stop ${POD_TO_KILL}`, { stdio: "ignore" });
    }
    const clientMessageId = `fo-${Date.now()}-${i}`;
    const { ack, attempts, ms } = await sendWithRetry(aliceSock, chatroomId, `failover msg ${i}`, clientMessageId);
    latencies.push(ms);
    if (attempts > 1) retried.push(i);
    if (ack.duplicate) duplicatesAcked++;
    if (ack.messageId) serverIds.add(ack.messageId);
    if (i % 10 === 0) process.stdout.write(`  · ${i}/${TOTAL}\n`);
    await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
  }

  // Let the last broadcasts land
  await new Promise((r) => setTimeout(r, 1500));

  // Ground truth from the database (via REST, cursor pages)
  interface Row {
    message: string;
    sequenceNumber: number;
    _id: string;
  }
  interface HistoryPage {
    messages: Row[];
    cursor: { nextCursor: string | null; hasMore: boolean };
  }
  const persisted: Row[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `/chatroom/${chatroomId}/messages?limit=100${cursor ? `&before=${cursor}` : ""}`;
    const page: HistoryPage = await rest<HistoryPage>(query, { token: alice.token });
    persisted.unshift(...page.messages);
    cursor = page.cursor.hasMore ? page.cursor.nextCursor : null;
  } while (cursor);

  const texts = persisted.map((m) => m.message);
  const seqs = persisted.map((m) => m.sequenceNumber);
  const uniqueTexts = new Set(texts).size;
  const gapFree = seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1);
  const bobTexts = new Set([...bobReceived.values()].map((v) => v.text)).size;

  const checks: Array<[string, boolean, string]> = [
    ["every message persisted exactly once", persisted.length === TOTAL && uniqueTexts === TOTAL, `${persisted.length} rows / ${uniqueTexts} unique of ${TOTAL}`],
    ["sequence numbers gap-free & increasing", gapFree, `${seqs[0]}…${seqs[seqs.length - 1]}`],
    ["Bob received every message exactly once", bobTexts === TOTAL && bobDuplicateEvents === 0, `${bobTexts}/${TOTAL} unique, ${bobDuplicateEvents} duplicate events`],
    ["server ACKed one id per message", serverIds.size === TOTAL, `${serverIds.size} ids (${duplicatesAcked} retries absorbed by dedup)`],
  ];

  console.log("\nResults");
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? "✓" : "✗"} ${label} — ${detail}`);
  console.log(`  ACK latency p50 ${percentile(latencies, 50)}ms · p95 ${percentile(latencies, 95)}ms · max ${Math.max(...latencies)}ms`);
  console.log(`  retried sends: ${retried.length ? retried.join(",") : "none"} · reconnects alice=${reconnects.alice} bob=${reconnects.bob}`);
  if (killedAt) console.log(`  pod stopped at #${KILL_AT}; pipeline kept flowing for the remaining ${TOTAL - KILL_AT + 1}`);

  if (!NO_KILL) {
    execSync(`docker compose -f "${COMPOSE_FILE}" start ${POD_TO_KILL}`, { stdio: "ignore" });
    console.log(`  ↻ ${POD_TO_KILL} restarted`);
  }

  aliceSock.disconnect();
  bobSock.disconnect();
  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? "\nPASS — zero lost, zero duplicated across failover" : "\nFAIL");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("failoverCheck error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
