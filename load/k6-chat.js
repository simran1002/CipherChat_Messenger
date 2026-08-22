/**
 * k6 load test — message send/ACK round-trip over Socket.IO.
 *
 * k6 has no socket.io client, so this speaks the engine.io v4 wire protocol
 * directly over WebSocket:
 *   server → "0{...}"      open packet (session established)
 *   client → "40"          namespace connect
 *   server → "40{...}"     namespace connected
 *   client → "421[...]"    emit with ack id 1 ("42" = event, "1" = ack id)
 *   server → "431[...]"    ack response for id 1
 *   server → "2" / client → "3"   heartbeat ping/pong
 *
 * Auth uses the server's query-token fallback (auth-payload form would go in
 * the "40" connect packet).
 *
 * Run (defaults target the docker-compose stack):
 *   k6 run load/k6-chat.js
 *   k6 run -e BASE_URL=http://localhost:8000 -e VUS=50 -e DURATION=60s load/k6-chat.js
 *
 * Scale target (documented in docs/): p95 ACK round-trip < 250 ms at
 * 100 msg/s sustained. 50 VUs × ~2 msg/s ≈ 100 msg/s.
 */
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8000";
const VUS = parseInt(__ENV.VUS || "50");
const DURATION = __ENV.DURATION || "60s";
// Fan-out control. Every send is broadcast to everyone in the room, so the
// delivery load is sends × room size. ROOMS=1 is a "hot room" stress test
// (50 VUs → 50× fan-out ≈ 2,900 deliveries/s); ROOMS=10 spreads 50 VUs five
// per room ≈ the documented org-wide target (~100 msg/s, realistic fan-out).
const ROOMS = Math.max(1, parseInt(__ENV.ROOMS || "10"));

const ackRtt = new Trend("chat_ack_rtt", true);
const messagesSent = new Counter("chat_messages_sent");
const messagesAcked = new Counter("chat_messages_acked");
const rateLimited = new Counter("chat_rate_limited");

export const options = {
  scenarios: {
    chat: {
      executor: "constant-vus",
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    chat_ack_rtt: ["p(95)<250", "p(99)<600"],
    checks: ["rate>0.98"],
  },
};

export function setup() {
  const stamp = Date.now();
  const tokens = [];

  // NOTE: setup registers one account per VU through /user/register, which
  // sits behind the auth rate limiter (100 requests / 15 min per client IP,
  // shared across replicas via Redis). Repeated runs from one IP will 429 —
  // between runs: `redis-cli --scan --pattern 'rl:*' | xargs redis-cli del`.

  // One account per VU (register returns a token directly)
  for (let i = 0; i < VUS; i++) {
    const res = http.post(
      `${BASE_URL}/user/register`,
      JSON.stringify({
        name: `k6 vu${i}`,
        email: `k6-${stamp}-${i}@test.cipher`,
        password: "password123",
      }),
      { headers: { "Content-Type": "application/json" } }
    );
    if (res.status !== 200) throw new Error(`register failed for vu${i}: ${res.status} ${res.body}`);
    tokens.push(res.json("token"));
  }

  const chatroomIds = [];
  for (let r = 0; r < ROOMS; r++) {
    const roomRes = http.post(
      `${BASE_URL}/chatroom`,
      JSON.stringify({ name: `LoadTest-${stamp}-${r}` }),
      { headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens[0]}` } }
    );
    if (roomRes.status !== 200) throw new Error(`room create failed: ${roomRes.status} ${roomRes.body}`);
    chatroomIds.push(roomRes.json("chatroom._id"));
  }

  return { tokens, chatroomIds };
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length];
  // VUs are dealt round-robin across rooms
  data.chatroomId = data.chatroomIds[(__VU - 1) % data.chatroomIds.length];
  const wsUrl =
    BASE_URL.replace(/^http/, "ws") +
    `/socket.io/?EIO=4&transport=websocket&token=${encodeURIComponent(token)}`;

  const res = ws.connect(wsUrl, {}, (socket) => {
    let ackId = 0;
    const inflight = {}; // ackId → send timestamp

    socket.on("open", () => {
      /* wait for engine.io open packet */
    });

    socket.on("message", (raw) => {
      if (raw.startsWith("0")) {
        socket.send("40"); // namespace connect
      } else if (raw.startsWith("40")) {
        socket.send(`42["joinRoom",{"chatroomId":"${data.chatroomId}"}]`);
        // Send one message every ~500ms for the VU's session
        socket.setInterval(() => {
          const id = ++ackId;
          inflight[id] = Date.now();
          const payload = JSON.stringify({
            chatroomId: data.chatroomId,
            message: `k6 load message ${__VU}-${id}`,
            clientMessageId: `k6-${__VU}-${__ITER}-${id}-${Date.now()}`,
          });
          socket.send(`42${id}["chatroomMessage",${payload}]`);
          messagesSent.add(1);
        }, 500);
      } else if (raw === "2") {
        socket.send("3"); // heartbeat pong
      } else if (raw.startsWith("43")) {
        // ack: "43<id>[{...}]"
        const m = raw.match(/^43(\d+)(\[.*\])$/);
        if (!m) return;
        const id = parseInt(m[1]);
        const sentAt = inflight[id];
        delete inflight[id];
        const body = JSON.parse(m[2])[0] || {};
        if (body.error === "rate_limited") {
          rateLimited.add(1);
        } else if (sentAt) {
          ackRtt.add(Date.now() - sentAt);
          messagesAcked.add(1);
          check(body, { "ack ok": (b) => b.ok === true });
        }
      }
    });

    // Each VU session lasts 10s, then reconnects (exercises connect path too)
    socket.setTimeout(() => socket.close(), 10_000);
  });

  check(res, { "ws session established": (r) => r && r.status === 101 });
  sleep(1);
}
