#!/usr/bin/env python3
"""
Cross-instance WebSocket fan-out check for the scale-out Compose profile.

    docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale backend=2
    python scripts/verify-fanout.py              # BASE_URL defaults to http://localhost:8080 (the nginx LB)

What it does
  1. registers two users, creates a public room both join
  2. opens two STOMP-over-WebSocket sessions through the LB (least_conn → they land on different replicas)
  3. A sends on /app/rooms/send; asserts A gets the ACK on /user/queue/acks and B receives the newMessage
     frame on /topic/rooms/{id}
  4. reads the backend containers' logs to show which replica accepted which CONNECT, so the
     cross-replica path (Redis pub/sub) is demonstrated rather than assumed
  5. also checks that an outsider's SUBSCRIBE to the room is refused (STOMP ERROR frame)

Exit code is non-zero on any failed check.
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import uuid

import websocket  # websocket-client

BASE = os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")
WS = BASE.replace("http", "ws", 1) + "/ws"
PASSWORD = "correct horse battery staple"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"  -- {detail}"))


def http(method, path, body=None, token=None):
    req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


def register(tag):
    st, body = http("POST", "/api/v1/auth/register", {"name": f"Fanout {tag}", "email": f"fanout-{tag}-{uuid.uuid4()}@stack.test", "password": PASSWORD})
    assert st == 201, (st, body)
    return {"token": body["token"], "id": body["user"]["id"], "name": f"Fanout {tag}"}


def frame(command, headers, body=""):
    return command + "\n" + "".join(f"{k}:{v}\n" for k, v in headers.items()) + "\n" + body + "\0"


def parse(raw):
    if raw in ("\n", ""):
        return None
    head, _, body = raw.partition("\n\n")
    lines = head.split("\n")
    headers = {}
    for h in lines[1:]:
        k, _, v = h.partition(":")
        headers[k] = v
    return {"command": lines[0], "headers": headers, "body": body.rstrip("\0")}


class Stomp:
    def __init__(self, token):
        self.ws = websocket.create_connection(WS, timeout=10)
        self.ws.send(frame("CONNECT", {"accept-version": "1.2", "heart-beat": "0,0", "Authorization": f"Bearer {token}"}))
        f = self.recv()
        assert f and f["command"] == "CONNECTED", f
        self.n = 0

    def recv(self, timeout=10):
        self.ws.settimeout(timeout)
        while True:
            f = parse(self.ws.recv())
            if f:
                return f

    def subscribe(self, dest):
        self.n += 1
        self.ws.send(frame("SUBSCRIBE", {"id": f"sub-{self.n}", "destination": dest}))

    def send(self, dest, obj):
        self.ws.send(frame("SEND", {"destination": dest, "content-type": "application/json"}, json.dumps(obj)))

    def close(self):
        try:
            self.ws.close()
        except Exception:
            pass


def compose_logs(service="backend", since="2m"):
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    r = subprocess.run(["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.scale.yml", "logs", "--no-log-prefix=false", "--since", since, service],
                       capture_output=True, text=True, cwd=root)
    return r.stdout


def main():
    a, b, eve = register("A"), register("B"), register("Eve")
    st, room = http("POST", "/api/v1/chatrooms", {"name": f"fanout-{uuid.uuid4().hex[:8]}", "isPrivate": False}, a["token"])
    assert st == 201, room
    room_id = room["id"]
    http("POST", f"/api/v1/chatrooms/{room_id}/join", None, b["token"])

    sa, sb = Stomp(a["token"]), Stomp(b["token"])
    sa.subscribe("/user/queue/acks")
    sb.subscribe(f"/topic/rooms/{room_id}")
    time.sleep(0.5)

    client_id = str(uuid.uuid4())
    t0 = time.time()
    sa.send("/app/rooms/send", {"chatroomId": room_id, "message": "cross-instance hello", "clientMessageId": client_id})
    ack = sa.recv()
    ack_ms = (time.time() - t0) * 1000
    body = json.loads(ack["body"])
    check("A receives ACK ok with sequenceNumber 1", ack["headers"].get("destination") == "/user/queue/acks" and body.get("ok") and body.get("sequenceNumber") == 1, ack)
    got = sb.recv()
    bcast_ms = (time.time() - t0) * 1000
    gb = json.loads(got["body"])
    check("B receives newMessage on the room topic", gb.get("event") == "newMessage" and gb["payload"].get("clientMessageId") == client_id, got)
    print(f"      ack {ack_ms:.0f} ms, broadcast to B {bcast_ms:.0f} ms")

    # Duplicate: same clientMessageId → duplicate ACK, no second broadcast
    sa.send("/app/rooms/send", {"chatroomId": room_id, "message": "cross-instance hello", "clientMessageId": client_id})
    dup = json.loads(sa.recv()["body"])
    check("duplicate send → ACK duplicate:true", dup.get("duplicate") is True, dup)
    try:
        extra = sb.recv(timeout=2)
        check("no second broadcast for the duplicate", False, extra)
    except websocket.WebSocketTimeoutException:
        check("no second broadcast for the duplicate", True)

    # Outsider subscription refused
    se = Stomp(eve["token"])
    se.subscribe(f"/topic/rooms/{room_id}")
    try:
        f = se.recv(timeout=5)
        check("outsider SUBSCRIBE to the room → STOMP ERROR", f["command"] == "ERROR", f)
    except websocket.WebSocketTimeoutException:
        check("outsider SUBSCRIBE to the room → STOMP ERROR", False, "no ERROR frame within 5 s")
    except websocket.WebSocketConnectionClosedException:
        check("outsider SUBSCRIBE to the room → STOMP ERROR (connection closed by server)", True)
    se.close()

    for s in (sa, sb):
        s.close()

    # Which replica handled which session? Presence log lines carry the user id per container.
    logs = compose_logs()
    replicas_a = sorted({ln.split("|")[0].strip() for ln in logs.splitlines() if a["id"] in ln and ("connected" in ln.lower() or "CONNECT" in ln)})
    replicas_b = sorted({ln.split("|")[0].strip() for ln in logs.splitlines() if b["id"] in ln and ("connected" in ln.lower() or "CONNECT" in ln)})
    print(f"      A's socket on: {replicas_a or 'unknown'} ; B's socket on: {replicas_b or 'unknown'}")
    if replicas_a and replicas_b:
        check("A and B were served by different replicas (cross-instance fan-out exercised)", replicas_a != replicas_b,
              f"{replicas_a} vs {replicas_b} — rerun; least_conn placed both on one replica this time")
    else:
        print("      (could not attribute sockets to replicas from logs — set LOG_LEVEL=DEBUG or inspect `docker compose logs backend`)")

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
