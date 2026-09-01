/**
 * Connection-density benchmark: how many concurrent Socket.IO connections
 * does ONE pod actually sustain?
 *
 * Distinct from load/k6-chat.js (message THROUGHPUT): this measures held
 * sockets — the "concurrent users" number — by ramping real authenticated
 * websocket connections with live presence heartbeats, holding them, and
 * then running a delivery probe THROUGH the held load to prove the pod is
 * still serving, not just accepting.
 *
 * The load generator is split across worker PROCESSES: a single Node client
 * event loop saturates around ~5k sockets and starts missing server pings,
 * so the server's ping timeout reaps perfectly healthy connections — the
 * first run of this script measured the load generator, not the server.
 *
 * Run against a dedicated backend + database:
 *   # terminal 1 — RAM-backed Mongo (keeps free-tier Atlas throttling out of
 *   #              the measurement): npx tsx scripts/benchdb.mts
 *   # terminal 2 — bench server:
 *   PORT=8200 DATABASE=mongodb://127.0.0.1:27099/cipherchat_bench npm run dev
 *   # terminal 3:
 *   DATABASE=mongodb://127.0.0.1:27099/cipherchat_bench \
 *     BENCH_URL=http://localhost:8200 TARGET=10000 npx tsx scripts/connflood.mts
 *
 * Knobs: TARGET (10000), RATE total conns/s (120), HOLD secs (60), WORKERS (4).
 *
 * Methodology caveats (documented in WHY-DIFFERENT): single machine,
 * loopback, mostly-idle connections with 25s heartbeats — this measures
 * connection + presence capacity, NOT message throughput at that scale
 * (delivery load is sends × room size; the k6 script measures that axis).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";

const BENCH_URL = process.env.BENCH_URL || "http://localhost:8200";
const TARGET = Number(process.env.TARGET) || 10_000;
const RATE = Number(process.env.RATE) || 120;
const HOLD_SEC = Number(process.env.HOLD) || 60;
const WORKERS = Number(process.env.WORKERS) || 4;
const HEARTBEAT_MS = 25_000;
const PROBE_SENDERS = 10;
const PROBE_MSGS_EACH = 20;

const log = (msg: string) => console.log(`[connflood ${new Date().toISOString().slice(11, 19)}] ${msg}`);
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Held {
  socket: ClientSocket;
  timer: NodeJS.Timeout;
}

function connect(token: string, connectMs: number[], onSettled: (ok: boolean) => void): Held {
  const started = Date.now();
  const socket = ioClient(BENCH_URL, {
    transports: ["websocket"],
    reconnection: false,
    forceNew: true, // one REAL tcp connection each — no manager multiplexing
    timeout: 30_000,
    auth: { token },
  });
  socket.once("connect", () => {
    connectMs.push(Date.now() - started);
    onSettled(true);
  });
  socket.once("connect_error", () => onSettled(false));
  const timer = setInterval(() => socket.connected && socket.emit("heartbeat"), HEARTBEAT_MS + Math.random() * 5000);
  timer.unref();
  return { socket, timer };
}

/** Ramp tokens at `rate`/s into `held`; resolves with tokens that failed. */
function ramp(tokens: string[], rate: number, held: Held[], connectMs: number[]): Promise<string[]> {
  return new Promise((resolve) => {
    const failedTokens: string[] = [];
    let settled = 0;
    let next = 0;
    const tick = setInterval(() => {
      for (let i = 0; i < Math.max(1, rate / 10) && next < tokens.length; i++, next++) {
        const token = tokens[next]!;
        held.push(
          connect(token, connectMs, (ok) => {
            settled++;
            if (!ok) failedTokens.push(token);
            if (settled === tokens.length) {
              clearInterval(tick);
              resolve(failedTokens);
            }
          })
        );
      }
    }, 100);
  });
}

// ── Worker: ramp a share of the connections, report, hold, exit ────────────
async function workerMain(): Promise<void> {
  const tokens = JSON.parse(readFileSync(process.env.TOKENS_FILE!, "utf8")) as string[];
  const rate = Number(process.env.WORKER_RATE) || 30;
  const held: Held[] = [];
  const connectMs: number[] = [];

  let pending = tokens;
  for (let pass = 1; pass <= 3 && pending.length > 0; pass++) {
    pending = await ramp(pending, Math.max(20, rate / pass), held, connectMs);
  }
  connectMs.sort((a, b) => a - b);
  const connected = held.filter((h) => h.socket.connected).length;
  console.log(
    `WORKER_READY ${JSON.stringify({ connected, failed: pending.length, p50: pct(connectMs, 50), p95: pct(connectMs, 95) })}`
  );

  // Hold through the master's hold window + probe, then leave cleanly
  await sleep((HOLD_SEC + 60) * 1000);
  const still = held.filter((h) => h.socket.connected).length;
  console.log(`WORKER_DONE ${JSON.stringify({ still })}`);
  for (const h of held) {
    clearInterval(h.timer);
    h.socket.disconnect();
  }
  process.exit(0);
}

// ── Master ────────────────────────────────────────────────────────────────
async function ensureBenchUsers(count: number): Promise<Array<{ id: string; token: string }>> {
  const { env } = await import("../src/config/env.js");
  const { signToken } = await import("../src/middlewares/auth.js");
  const { User } = await import("../src/models/User.js");
  const mongoose = (await import("mongoose")).default;

  await mongoose.connect(env.DATABASE);
  log(`ensuring ${count} bench users exist…`);
  const emails = Array.from({ length: count }, (_, i) => `connflood-${i}@bench.local`);
  for (let at = 0; at < count; at += 1000) {
    const chunk = emails.slice(at, at + 1000);
    await User.bulkWrite(
      chunk.map((email, j) => ({
        updateOne: {
          filter: { email },
          update: { $setOnInsert: { name: `Bench User ${at + j}`, email, password: "!bench-no-login!" } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  }
  const rows = await User.find({ email: { $in: emails } }).select("_id").lean();
  const users = rows.map((r) => ({ id: String(r._id), token: signToken({ id: String(r._id) }) }));
  await mongoose.disconnect();
  log(`bench users ready: ${users.length}`);
  return users;
}

async function scrapeServer(): Promise<{ rssMb: number; sockets: number }> {
  try {
    const text = await (await fetch(`${BENCH_URL}/metrics`)).text();
    const num = (name: string) => Number(text.match(new RegExp(`^${name}\\s+(\\S+)`, "m"))?.[1] ?? NaN);
    return {
      rssMb: Math.round(num("process_resident_memory_bytes") / 1024 / 1024),
      sockets: num("cipherchat_sockets_connected"),
    };
  } catch {
    return { rssMb: NaN, sockets: NaN };
  }
}

async function deliveryProbe(probeUsers: Array<{ token: string }>): Promise<number[]> {
  const held: Held[] = [];
  const connectMs: number[] = [];
  await ramp(probeUsers.map((u) => u.token), 10, held, connectMs);
  const senders = held.filter((h) => h.socket.connected).map((h) => h.socket);
  if (senders.length === 0) throw new Error("no probe sockets connected");

  const createRes = await fetch(`${BENCH_URL}/chatroom`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${probeUsers[0]!.token}`,
    },
    body: JSON.stringify({ name: `Bench Probe ${Date.now() % 100000}` }),
  });
  const room = (await createRes.json()) as { _id?: string; chatroom?: { _id: string } };
  const chatroomId = room._id ?? room.chatroom?._id;
  if (!chatroomId) throw new Error(`probe room creation failed: ${JSON.stringify(room).slice(0, 200)}`);

  for (const s of senders) s.emit("joinRoom", { chatroomId });
  await sleep(1000);

  const rtts: number[] = [];
  for (let round = 0; round < PROBE_MSGS_EACH; round++) {
    await Promise.all(
      senders.map(
        (s, i) =>
          new Promise<void>((resolve) => {
            const t0 = Date.now();
            const timeout = setTimeout(resolve, 10_000);
            s.emit(
              "chatroomMessage",
              { chatroomId, message: `probe r${round} s${i}`, clientMessageId: crypto.randomUUID() },
              (ack: { ok?: boolean }) => {
                clearTimeout(timeout);
                if (ack?.ok) rtts.push(Date.now() - t0);
                resolve();
              }
            );
          })
      )
    );
    await sleep(400); // stay inside the token bucket
  }
  for (const h of held) {
    clearInterval(h.timer);
    h.socket.disconnect();
  }
  return rtts.sort((a, b) => a - b);
}

async function masterMain(): Promise<void> {
  const before = await scrapeServer();
  log(`server before ramp: rss=${before.rssMb}MB sockets=${before.sockets}`);

  const users = await ensureBenchUsers(TARGET + PROBE_SENDERS);
  const probeUsers = users.slice(TARGET);

  const dir = mkdtempSync(path.join(tmpdir(), "connflood-"));
  const perWorker = Math.ceil(TARGET / WORKERS);
  const self = fileURLToPath(import.meta.url);

  log(`spawning ${WORKERS} workers × ~${perWorker} connections (total ramp ~${RATE}/s)…`);
  const t0 = Date.now();
  const readies: Array<{ connected: number; failed: number; p50: number; p95: number }> = [];
  const dones: Array<{ still: number }> = [];

  const workers = Array.from({ length: WORKERS }, (_, w) => {
    const slice = users.slice(w * perWorker, (w + 1) * perWorker).map((u) => u.token);
    const tokensFile = path.join(dir, `tokens-${w}.json`);
    writeFileSync(tokensFile, JSON.stringify(slice));
    // node --import tsx (no shell): survives spaces in the repo path, which
    // a shell:true + npx spawn silently does not
    const child = spawn(process.execPath, ["--import", "tsx", self], {
      env: {
        ...process.env,
        CONNFLOOD_ROLE: "worker",
        TOKENS_FILE: tokensFile,
        WORKER_RATE: String(Math.ceil(RATE / WORKERS)),
        BENCH_URL,
        HOLD: String(HOLD_SEC),
      },
    });
    child.stdout.on("data", (buf: Buffer) => {
      for (const line of buf.toString().split("\n")) {
        if (line.startsWith("WORKER_READY ")) readies.push(JSON.parse(line.slice(13)));
        else if (line.startsWith("WORKER_DONE ")) dones.push(JSON.parse(line.slice(12)));
        else if (line.trim()) console.log(`  [w${w}] ${line.trim()}`);
      }
    });
    child.stderr.on("data", (buf: Buffer) => console.error(`  [w${w}!] ${buf.toString().trim()}`));
    return child;
  });

  while (readies.length < WORKERS) await sleep(1000);
  const rampSec = Math.round((Date.now() - t0) / 10) / 100;
  const connected = readies.reduce((a, r) => a + r.connected, 0);
  const failed = readies.reduce((a, r) => a + r.failed, 0);
  const atPeak = await scrapeServer();
  log(`RAMP DONE in ${rampSec}s: client-connected=${connected} failed=${failed}`);
  log(`worker connect p95s: ${readies.map((r) => `${r.p95}ms`).join(" ")}`);
  log(`server at peak: rss=${atPeak.rssMb}MB sockets=${atPeak.sockets}`);

  log(`holding for ${HOLD_SEC}s (heartbeats live)…`);
  await sleep(HOLD_SEC * 1000);
  const afterHold = await scrapeServer();
  log(`after hold: server gauge=${afterHold.sockets} rss=${afterHold.rssMb}MB`);

  log(`delivery probe: ${PROBE_SENDERS} senders × ${PROBE_MSGS_EACH} msgs through the held load…`);
  const rtts = await deliveryProbe(probeUsers);
  log(`probe acks: ${rtts.length}/${PROBE_SENDERS * PROBE_MSGS_EACH} ok — RTT p50=${pct(rtts, 50)}ms p95=${pct(rtts, 95)}ms`);

  console.log(
    JSON.stringify(
      {
        target: TARGET,
        workers: WORKERS,
        clientConnected: connected,
        failed,
        rampSec,
        serverSocketsAtPeak: atPeak.sockets,
        serverSocketsAfterHold: afterHold.sockets,
        serverRssMb: afterHold.rssMb,
        heldSec: HOLD_SEC,
        probeAcks: rtts.length,
        probeP50: pct(rtts, 50),
        probeP95: pct(rtts, 95),
      },
      null,
      2
    )
  );

  const verdict = afterHold.sockets >= TARGET && rtts.length === PROBE_SENDERS * PROBE_MSGS_EACH;
  log(verdict ? `PASS — ${afterHold.sockets} concurrent connections held and still delivering` : "PARTIAL — see numbers above");

  while (dones.length < WORKERS) await sleep(1000);
  for (const w of workers) w.kill();
  process.exit(0);
}

if (process.env.CONNFLOOD_ROLE === "worker") {
  workerMain().catch((err) => {
    console.error("worker failed:", err);
    process.exit(1);
  });
} else {
  masterMain().catch((err) => {
    console.error("connflood failed:", err);
    process.exit(1);
  });
}
