// k6 load test for the Java backend: REST latency + STOMP-over-WebSocket send → ACK → broadcast.
//
//   docker run --rm -i -e BASE_URL=http://host.docker.internal:8080 grafana/k6 run - < load/k6-stomp.js
//   (Linux without Docker Desktop: --network host -e BASE_URL=http://localhost:8080)
//
// Knobs (env): VUS (chat VUs, default 30), ROOMS (default 5), MSGS_PER_VU (default 20), DURATION (default 60s).
//
// Scenarios
//   rest — register, list rooms, read profile: HTTP latency under concurrent load.
//   chat — each VU registers, joins one of ROOMS shared public rooms over STOMP, sends
//          MSGS_PER_VU messages and measures time-to-ACK (persisted) and time-to-broadcast
//          (the same message arriving back on the room topic through the fan-out path).
//
// k6 ships no STOMP client, so STOMP 1.2 frames are built by hand over the raw WebSocket.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL || "http://localhost:8080";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws";
const ROOMS = Number(__ENV.ROOMS || 5);
const MSGS_PER_VU = Number(__ENV.MSGS_PER_VU || 20);
const VUS = Number(__ENV.VUS || 30);
const DURATION = __ENV.DURATION || "60s";
const PASSWORD = "correct horse battery staple";

export const ackLatency = new Trend("stomp_ack_ms", true);
export const broadcastLatency = new Trend("stomp_broadcast_ms", true);
export const restLatency = new Trend("rest_ms", true);
export const sent = new Counter("messages_sent");
export const acked = new Counter("messages_acked");
export const dupAcks = new Counter("duplicate_acks");
export const errors = new Rate("errors");

export const options = {
  scenarios: {
    rest: { executor: "constant-vus", vus: 5, duration: DURATION, exec: "rest" },
    chat: { executor: "constant-vus", vus: VUS, duration: DURATION, exec: "chat" },
  },
  thresholds: {
    stomp_ack_ms: ["p(95)<500"],
    stomp_broadcast_ms: ["p(95)<750"],
    rest_ms: ["p(95)<400"],
    errors: ["rate<0.01"],
  },
};

function register(tag) {
  const email = `k6-${tag}-${uuidv4()}@load.test`;
  const res = http.post(`${BASE}/api/v1/auth/register`,
    JSON.stringify({ name: `k6 ${tag}`, email, password: PASSWORD }),
    { headers: { "Content-Type": "application/json" } });
  restLatency.add(res.timings.duration);
  const ok = check(res, { "register 201": (r) => r.status === 201 });
  errors.add(!ok);
  return ok ? { token: res.json("token"), id: res.json("user.id"), email } : null;
}

function auth(token) {
  return { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } };
}

// Runs once: one owner creates the shared public rooms; VUs join them by id.
export function setup() {
  const owner = register("setup");
  if (!owner) throw new Error("setup: register failed — is the backend reachable at " + BASE + "?");
  const rooms = [];
  for (let i = 0; i < ROOMS; i++) {
    const res = http.post(`${BASE}/api/v1/chatrooms`,
      JSON.stringify({ name: `k6-${Date.now().toString(36)}-${i}`, isPrivate: false }), auth(owner.token));
    if (res.status !== 201) throw new Error(`setup: create room failed ${res.status} ${res.body}`);
    rooms.push(res.json("id"));
  }
  return { rooms };
}

// STOMP 1.2 frame: COMMAND\nheader:value\n\nbody\0
function frame(command, headers, body) {
  let s = command + "\n";
  for (const k in headers) s += `${k}:${headers[k]}\n`;
  return s + "\n" + (body || "") + "\0";
}

function parseFrame(raw) {
  if (raw === "\n" || raw === "") return null; // heartbeat
  const end = raw.indexOf("\n\n");
  const head = raw.slice(0, end).split("\n");
  const command = head.shift();
  const headers = {};
  for (const h of head) { const i = h.indexOf(":"); if (i > 0) headers[h.slice(0, i)] = h.slice(i + 1); }
  const body = raw.slice(end + 2).replace(/\0$/, "");
  return { command, headers, body };
}

export function rest() {
  const user = register("rest");
  if (!user) return;
  const list = http.get(`${BASE}/api/v1/chatrooms`, auth(user.token));
  restLatency.add(list.timings.duration);
  errors.add(!check(list, { "rooms 200": (r) => r.status === 200 }));
  const me = http.get(`${BASE}/api/v1/users/me`, auth(user.token));
  restLatency.add(me.timings.duration);
  errors.add(!check(me, { "me 200": (r) => r.status === 200 }));
  sleep(1);
}

export function chat(data) {
  const user = register("chat");
  if (!user) return;
  const roomId = data.rooms[__VU % data.rooms.length];
  const join = http.post(`${BASE}/api/v1/chatrooms/${roomId}/join`, null, auth(user.token));
  restLatency.add(join.timings.duration);
  if (!check(join, { "join 200": (r) => r.status === 200 })) { errors.add(true); return; }

  const pending = new Map(); // clientMessageId → sentAt (ms)
  const res = ws.connect(WS_URL, {}, function (socket) {
    let subId = 0;
    socket.on("open", () => {
      socket.send(frame("CONNECT", { "accept-version": "1.2", "heart-beat": "0,0", Authorization: `Bearer ${user.token}` }));
    });
    socket.on("message", (raw) => {
      const f = parseFrame(raw);
      if (!f) return;
      if (f.command === "CONNECTED") {
        socket.send(frame("SUBSCRIBE", { id: `sub-${++subId}`, destination: "/user/queue/acks" }));
        socket.send(frame("SUBSCRIBE", { id: `sub-${++subId}`, destination: `/topic/rooms/${roomId}` }));
        let n = 0;
        const tick = () => {
          if (n++ >= MSGS_PER_VU) { socket.setTimeout(() => socket.close(), 3000); return; }
          const clientMessageId = uuidv4();
          pending.set(clientMessageId, Date.now());
          sent.add(1);
          socket.send(frame("SEND", { destination: "/app/rooms/send", "content-type": "application/json" },
            JSON.stringify({ chatroomId: roomId, message: `k6 vu${__VU} #${n}`, clientMessageId })));
          socket.setTimeout(tick, 250 + Math.random() * 250);
        };
        tick();
      } else if (f.command === "MESSAGE") {
        let body; try { body = JSON.parse(f.body); } catch (e) { return; }
        if (f.headers.destination === "/user/queue/acks") {
          const at = pending.get(body.clientMessageId);
          if (at !== undefined) { ackLatency.add(Date.now() - at); acked.add(1); if (body.duplicate) dupAcks.add(1); }
          if (!body.ok) errors.add(true);
        } else if (body.event === "newMessage" && body.payload && body.payload.clientMessageId) {
          const at = pending.get(body.payload.clientMessageId);
          if (at !== undefined) broadcastLatency.add(Date.now() - at);
        }
      } else if (f.command === "ERROR") {
        errors.add(true);
        socket.close();
      }
    });
    socket.on("error", () => errors.add(true));
    socket.setTimeout(() => socket.close(), 55000);
  });
  check(res, { "ws 101": (r) => r && r.status === 101 });
}
