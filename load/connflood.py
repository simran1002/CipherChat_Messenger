#!/usr/bin/env python3
"""
Connection-density and fan-out measurement for the CipherChat STOMP gateway.

    python load/connflood.py --sockets 10000 --users 100 --hold 60 --broadcasts 20

What it measures, against a running backend (BASE_URL, default http://localhost:8080):
  1. registers USERS accounts, creates one public room, joins every user to it;
  2. opens SOCKETS raw-WebSocket STOMP connections (round-robin over the users) with the real
     client's heartbeat interval, authenticates at CONNECT, subscribes to the room topic and the
     private ACK queue; records connect latency and failures;
  3. holds them for HOLD seconds, and during the hold sends BROADCASTS messages (one per second,
     from distinct sockets) whose body carries the send timestamp; every receiver records arrival
     time, giving broadcast latency (p50/p95/max) and delivery completeness across all sockets;
  4. samples the backend's own gauges (open sessions, JVM heap) from /actuator/prometheus and
     `docker stats` for the backend container at steady state.

Writes a JSON report (--out) and prints a summary. Requires: websockets>=12, httpx.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
import subprocess
import sys
import time
import uuid

import httpx
import websockets

HEARTBEAT_MS = 10_000          # same as chat-front/src/services/stompSocket.ts
PASSWORD = "correct horse battery staple"


def frame(command: str, headers: dict[str, str], body: str = "") -> str:
    return command + "\n" + "".join(f"{k}:{v}\n" for k, v in headers.items()) + "\n" + body + "\0"


def parse(raw: str | bytes):
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    raw = raw.rstrip("\0")
    if not raw.strip():
        return None, {}, ""
    head, _, body = raw.partition("\n\n")
    lines = head.split("\n")
    headers = {}
    for line in lines[1:]:
        k, _, v = line.partition(":")
        headers[k] = v
    return lines[0], headers, body


def pct(values: list[float], p: float) -> float:
    if not values:
        return float("nan")
    s = sorted(values)
    k = max(0, min(len(s) - 1, round(p / 100 * (len(s) - 1))))
    return s[k]


async def register_users(base: str, n: int) -> list[dict]:
    async with httpx.AsyncClient(base_url=base, timeout=30) as http:
        sem = asyncio.Semaphore(8)      # BCrypt(12) ≈ 250 ms per hash; keep the server responsive

        async def one(i: int):
            async with sem:
                r = await http.post("/api/v1/auth/register", json={
                    "name": f"flood {i}", "email": f"flood-{i}-{uuid.uuid4().hex[:8]}@load.test",
                    "password": PASSWORD})
                r.raise_for_status()
                j = r.json()
                return {"token": j["token"], "id": j["user"]["id"]}

        return await asyncio.gather(*(one(i) for i in range(n)))


async def create_room(base: str, users: list[dict]) -> str:
    async with httpx.AsyncClient(base_url=base, timeout=30) as http:
        owner = users[0]
        r = await http.post("/api/v1/chatrooms", json={"name": f"flood-{int(time.time())}", "isPrivate": False},
                            headers={"Authorization": f"Bearer {owner['token']}"})
        r.raise_for_status()
        room = r.json()["id"]
        sem = asyncio.Semaphore(16)

        async def join(u):
            async with sem:
                rr = await http.post(f"/api/v1/chatrooms/{room}/join", headers={"Authorization": f"Bearer {u['token']}"})
                if rr.status_code not in (200, 201, 409):
                    raise RuntimeError(f"join failed {rr.status_code} {rr.text[:120]}")

        await asyncio.gather(*(join(u) for u in users[1:]))
        return room


class Stats:
    def __init__(self):
        self.connect_ms: list[float] = []
        self.failures: dict[str, int] = {}
        self.connected = 0
        self.dropped = 0
        self.broadcast_ms: list[float] = []
        self.received = 0
        self.acks = 0
        self.ack_ms: list[float] = []

    def fail(self, why: str):
        self.failures[why] = self.failures.get(why, 0) + 1


async def socket_task(idx: int, ws_url: str, token: str, room: str, st: Stats, ready: asyncio.Event,
                      stop: asyncio.Event, senders: dict[int, asyncio.Queue]):
    t0 = time.perf_counter()
    try:
        ws = await websockets.connect(ws_url, max_size=1 << 20, ping_interval=None, open_timeout=30,
                                      subprotocols=["v12.stomp", "v11.stomp", "v10.stomp"])
    except Exception as e:  # noqa: BLE001
        st.fail("ws_open:" + type(e).__name__)
        return
    try:
        await ws.send(frame("CONNECT", {"accept-version": "1.2", "host": "localhost",
                                        "heart-beat": f"{HEARTBEAT_MS},{HEARTBEAT_MS}",
                                        "Authorization": f"Bearer {token}"}))
        cmd, _, _ = parse(await asyncio.wait_for(ws.recv(), 30))
        if cmd != "CONNECTED":
            st.fail("connect:" + str(cmd))
            return
        st.connect_ms.append((time.perf_counter() - t0) * 1000)
        await ws.send(frame("SUBSCRIBE", {"id": "acks", "destination": "/user/queue/acks"}))
        await ws.send(frame("SUBSCRIBE", {"id": "room", "destination": f"/topic/rooms/{room}"}))
        st.connected += 1
        my_queue = senders.get(idx)

        async def heartbeat():
            while not stop.is_set():
                await asyncio.sleep(HEARTBEAT_MS / 1000)
                await ws.send("\n")

        async def sender():
            if my_queue is None:
                return
            while not stop.is_set():
                try:
                    clientMessageId = await asyncio.wait_for(my_queue.get(), 1.0)
                except asyncio.TimeoutError:
                    continue
                sent_at = time.time()
                body = json.dumps({"chatroomId": room, "clientMessageId": clientMessageId,
                                   "message": f"flood {sent_at:.6f}"})
                pending[clientMessageId] = sent_at
                await ws.send(frame("SEND", {"destination": "/app/rooms/send", "content-type": "application/json"}, body))

        pending: dict[str, float] = {}
        hb = asyncio.create_task(heartbeat())
        sd = asyncio.create_task(sender())
        try:
            while not stop.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), 1.0)
                except asyncio.TimeoutError:
                    continue
                cmd, headers, body = parse(raw)
                if cmd != "MESSAGE":
                    continue
                now = time.time()
                dest = headers.get("destination", "")
                if dest.startswith("/topic/rooms/"):
                    try:
                        payload = json.loads(body)          # RedisFanout.Frame {event, payload: MessageView}
                        view = payload.get("payload") if isinstance(payload.get("payload"), dict) else payload
                        text = view.get("message") or ""
                        if isinstance(text, str) and text.startswith("flood "):
                            st.broadcast_ms.append((now - float(text.split()[1])) * 1000)
                            st.received += 1
                    except Exception:  # noqa: BLE001
                        pass
                elif dest.endswith("/queue/acks"):
                    try:
                        ack = json.loads(body)
                        cid = ack.get("clientMessageId")
                        if cid in pending:
                            st.ack_ms.append((now - pending.pop(cid)) * 1000)
                            st.acks += 1
                    except Exception:  # noqa: BLE001
                        pass
        finally:
            hb.cancel()
            sd.cancel()
    except websockets.ConnectionClosed:
        st.dropped += 1
    except Exception as e:  # noqa: BLE001
        st.fail("run:" + type(e).__name__)
    finally:
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass


def prometheus_gauges(base: str) -> dict:
    out = {}
    try:
        text = httpx.get(base + "/actuator/prometheus", timeout=10).text
        for line in text.splitlines():
            if line.startswith("cipherchat_ws_sessions ") or line.startswith("cipherchat_ws_sessions{"):
                out["ws_sessions"] = float(line.rsplit(" ", 1)[1])
            elif line.startswith("cipherchat_ws_sessions_peak"):
                out["ws_sessions_peak"] = float(line.rsplit(" ", 1)[1])
            elif line.startswith("jvm_memory_used_bytes{") and 'area="heap"' in line:
                out["jvm_heap_used_mb"] = out.get("jvm_heap_used_mb", 0) + float(line.rsplit(" ", 1)[1]) / 1e6
            elif line.startswith("jvm_memory_used_bytes{") and 'area="nonheap"' in line:
                out["jvm_nonheap_used_mb"] = out.get("jvm_nonheap_used_mb", 0) + float(line.rsplit(" ", 1)[1]) / 1e6
            elif line.startswith("jvm_threads_live_threads"):
                out["jvm_threads"] = float(line.rsplit(" ", 1)[1])
            elif line.startswith("process_cpu_usage"):
                out["process_cpu_usage"] = float(line.rsplit(" ", 1)[1])
    except Exception as e:  # noqa: BLE001
        out["error"] = type(e).__name__
    return out


def docker_stats(container: str) -> dict:
    try:
        if not container:
            container = subprocess.run(["docker", "compose", "ps", "--format", "{{.Name}}", "backend"],
                                       capture_output=True, text=True, timeout=30).stdout.strip().splitlines()[0]
        r = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}|{{.CPUPerc}}", container],
                           capture_output=True, text=True, timeout=30)
        mem, cpu = r.stdout.strip().split("|")
        return {"container": container, "container_mem": mem, "container_cpu": cpu}
    except Exception as e:  # noqa: BLE001
        return {"error": type(e).__name__}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("BASE_URL", "http://localhost:8080"))
    ap.add_argument("--sockets", type=int, default=10000)
    ap.add_argument("--users", type=int, default=100)
    ap.add_argument("--ramp", type=int, default=250, help="new connections per second")
    ap.add_argument("--hold", type=int, default=60, help="seconds to hold once all sockets are open")
    ap.add_argument("--broadcasts", type=int, default=20)
    ap.add_argument("--container", default="", help="backend container name (default: resolved via docker compose)")
    ap.add_argument("--out", default="load/connflood-result.json")
    a = ap.parse_args()

    ws_url = a.base.replace("http", "ws", 1).rstrip("/") + "/ws"
    print(f"[1/4] registering {a.users} users …", flush=True)
    t = time.perf_counter()
    users = await register_users(a.base, a.users)
    print(f"      done in {time.perf_counter()-t:.1f}s")
    print("[2/4] creating room and joining users …", flush=True)
    room = await create_room(a.base, users)
    print(f"      room {room}")

    st = Stats()
    stop = asyncio.Event()
    ready = asyncio.Event()
    sender_ids = list(range(0, a.sockets, max(1, a.sockets // max(1, a.broadcasts))))[: a.broadcasts]
    senders = {i: asyncio.Queue() for i in sender_ids}
    baseline = prometheus_gauges(a.base)

    print(f"[3/4] opening {a.sockets} sockets at {a.ramp}/s …", flush=True)
    tasks = []
    t_open = time.perf_counter()
    for i in range(a.sockets):
        tasks.append(asyncio.create_task(socket_task(i, ws_url, users[i % len(users)]["token"], room, st, ready, stop, senders)))
        if (i + 1) % a.ramp == 0:
            await asyncio.sleep(1)
            print(f"      {i+1} launched, {st.connected} connected, failures={sum(st.failures.values())}", flush=True)
    # wait for connects to settle
    for _ in range(60):
        await asyncio.sleep(1)
        if st.connected + sum(st.failures.values()) >= a.sockets:
            break
    t_all = time.perf_counter() - t_open
    print(f"      {st.connected}/{a.sockets} connected in {t_all:.1f}s; failures={st.failures}", flush=True)

    steady = prometheus_gauges(a.base)
    stats = docker_stats(a.container)
    print(f"      server gauges: {steady} | {stats}", flush=True)

    print(f"[4/4] holding {a.hold}s; {a.broadcasts} broadcasts to {st.connected} subscribers …", flush=True)
    for k, i in enumerate(sender_ids):
        await asyncio.sleep(1)
        await senders[i].put(str(uuid.uuid4()))
    remaining = a.hold - len(sender_ids)
    await asyncio.sleep(max(5, remaining))
    end_gauges = prometheus_gauges(a.base)
    stop.set()
    await asyncio.gather(*tasks, return_exceptions=True)

    expected = st.connected * a.broadcasts
    report = {
        "target": a.base, "sockets_requested": a.sockets, "users": a.users, "ramp_per_s": a.ramp,
        "connected": st.connected, "connect_failures": st.failures, "dropped_during_hold": st.dropped,
        "time_to_all_connected_s": round(t_all, 1),
        "connect_ms": {"p50": round(pct(st.connect_ms, 50), 1), "p95": round(pct(st.connect_ms, 95), 1),
                       "p99": round(pct(st.connect_ms, 99), 1), "max": round(max(st.connect_ms), 1) if st.connect_ms else None},
        "broadcasts": {"sent": a.broadcasts, "acks": st.acks,
                       "ack_ms": {"p50": round(pct(st.ack_ms, 50), 1), "p95": round(pct(st.ack_ms, 95), 1)},
                       "deliveries_expected": expected, "deliveries_received": st.received,
                       "completeness": round(st.received / expected, 4) if expected else None,
                       "broadcast_ms": {"p50": round(pct(st.broadcast_ms, 50), 1), "p95": round(pct(st.broadcast_ms, 95), 1),
                                        "p99": round(pct(st.broadcast_ms, 99), 1),
                                        "max": round(max(st.broadcast_ms), 1) if st.broadcast_ms else None}},
        "server_baseline": baseline, "server_steady": steady, "server_end": end_gauges, "docker_stats_steady": stats,
        "heartbeat_ms": HEARTBEAT_MS, "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
    }
    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    # Windows: keep the default Proactor loop — the selector loop is capped at 512 sockets.
    asyncio.run(main())
