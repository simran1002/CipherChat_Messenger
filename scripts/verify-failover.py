#!/usr/bin/env python3
"""
Kill-a-pod delivery check for the scale-out Compose profile.

    docker compose -f docker-compose.yml -f docker-compose.scale.yml up -d --scale backend=2
    python scripts/verify-failover.py            # BASE_URL defaults to http://localhost:8080 (the nginx LB)

What it does
  1. registers a sender and an observer, creates a room, connects both through the load balancer
  2. finds the replica that holds the SENDER's socket (ESTABLISHED connections on :8080 in /proc/net/tcp*)
  3. sends TOTAL messages the way the real client does: one clientMessageId per message, wait for the ACK,
     and on a timeout or a dropped socket reconnect and resend THE SAME id
  4. after KILL_AFTER acknowledged messages it SIGKILLs the sender's replica (no graceful drain)
  5. reads the room history over REST and asserts: exactly TOTAL rows, no duplicate clientMessageId,
     sequence numbers contiguous 1..TOTAL, order equal to send order
  6. reports the delivery gap the user would have felt, how many sends had to be retried, and how many of
     those retries the server absorbed as duplicates

Exit code is non-zero on any failed check. The killed replica is restarted at the end.
"""
import atexit
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

import websocket  # websocket-client

BASE = os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")
WS = BASE.replace("http", "ws", 1) + "/ws"
TOTAL = int(os.environ.get("TOTAL", "60"))
KILL_AFTER = int(os.environ.get("KILL_AFTER", "20"))
ACK_TIMEOUT = float(os.environ.get("ACK_TIMEOUT", "3"))
PASSWORD = "correct horse battery staple"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPOSE = ["docker", "compose", "-f", "docker-compose.yml", "-f", "docker-compose.scale.yml"]
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"  -- {detail}"))


def http(method, path, body=None, token=None, attempts=8):
    """REST through the LB. Retries connection-level failures: a request can be in flight to the dying replica."""
    last = None
    for i in range(attempts):
        req = urllib.request.Request(BASE + path, data=None if body is None else json.dumps(body).encode(), method=method)
        req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            if e.code in (502, 503, 504):
                last = e
            else:
                return e.code, json.loads(e.read() or b"null")
        except (urllib.error.URLError, ConnectionError, TimeoutError) as e:
            last = e
        time.sleep(0.5 * (i + 1))
    raise RuntimeError(f"{method} {path} failed after {attempts} attempts: {last}")


def register(tag):
    st, body = http("POST", "/api/v1/auth/register",
                    {"name": f"Failover {tag}", "email": f"failover-{tag}-{uuid.uuid4()}@stack.test", "password": PASSWORD})
    assert st == 201, (st, body)
    return {"token": body["token"], "id": body["user"]["id"]}


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


def connect_with_backoff(token, deadline_s=60):
    """The client's reconnect loop: capped exponential backoff until a replica accepts the CONNECT."""
    delay, start = 0.25, time.time()
    while True:
        try:
            s = Stomp(token)
            s.subscribe("/user/queue/acks")
            return s
        except Exception as e:  # LB 502 while the upstream is marked down, refused socket, handshake timeout
            if time.time() - start > deadline_s:
                raise RuntimeError(f"could not reconnect within {deadline_s}s: {e}")
            time.sleep(delay)
            delay = min(delay * 2, 2.0)


def backend_containers():
    r = subprocess.run(COMPOSE + ["ps", "-q", "backend"], capture_output=True, text=True, cwd=ROOT)
    ids = [x for x in r.stdout.split() if x]
    names = {}
    for cid in ids:
        n = subprocess.run(["docker", "inspect", "-f", "{{.Name}}", cid], capture_output=True, text=True).stdout.strip().lstrip("/")
        names[cid] = n
    return names


def established_on_8080(cid):
    """Count ESTABLISHED (state 01) sockets with local port 8080 (0x1F90) inside a container."""
    r = subprocess.run(["docker", "exec", cid, "sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"], capture_output=True, text=True)
    count = 0
    for ln in r.stdout.splitlines():
        parts = ln.split()
        if len(parts) > 3 and parts[1].endswith(":1F90") and parts[3] == "01":
            count += 1
    return count


def holder_of_new_socket(before):
    """The replica whose ESTABLISHED count rose after a client connected."""
    for _ in range(10):
        after = {cid: established_on_8080(cid) for cid in before}
        grown = [cid for cid in before if after[cid] > before[cid]]
        if len(grown) == 1:
            return grown[0]
        time.sleep(0.3)
    return None


def restore_replicas():
    """Bring the killed replica back — registered as soon as one is killed, so a failed run never leaves the stack short."""
    subprocess.run(COMPOSE + ["up", "-d", "--scale", "backend=2", "--no-recreate"], capture_output=True, cwd=ROOT)


def main():
    containers = backend_containers()
    check("two backend replicas are running behind the load balancer", len(containers) >= 2, containers)
    if len(containers) < 2:
        sys.exit(1)

    sender, observer = register("sender"), register("observer")
    st, room = http("POST", "/api/v1/chatrooms", {"name": f"failover-{uuid.uuid4().hex[:8]}", "isPrivate": False}, sender["token"])
    assert st == 201, room
    room_id = room["id"]
    http("POST", f"/api/v1/chatrooms/{room_id}/join", None, observer["token"])

    time.sleep(1.0)  # let health-check sockets close so the baseline is quiet
    baseline = {cid: established_on_8080(cid) for cid in containers}
    s = connect_with_backoff(sender["token"])
    victim = holder_of_new_socket(baseline)
    check("located the replica holding the sender's socket", victim is not None, baseline)
    if victim is None:
        sys.exit(1)
    print(f"      sender's socket is on {containers[victim]}")

    ids = [str(uuid.uuid4()) for _ in range(TOTAL)]
    retried, duplicates_absorbed, reconnects, throttled = 0, 0, 0, 0
    killed_at, recovered_at = None, None
    i = 0
    while i < TOTAL:
        if i == KILL_AFTER and killed_at is None:
            atexit.register(restore_replicas)
            subprocess.run(["docker", "kill", "--signal", "KILL", victim], capture_output=True)
            killed_at = time.time()
            print(f"      SIGKILL {containers[victim]} after {KILL_AFTER} acknowledged messages")
        payload = {"chatroomId": room_id, "message": f"failover message {i + 1:03d}", "clientMessageId": ids[i]}
        try:
            s.send("/app/rooms/send", payload)
            ack = None
            deadline = time.time() + ACK_TIMEOUT
            while time.time() < deadline:
                f = s.recv(timeout=max(0.1, deadline - time.time()))
                if f["command"] == "MESSAGE":
                    body = json.loads(f["body"])
                    if body.get("clientMessageId") == ids[i]:
                        ack = body
                        break
            if ack is None:
                raise TimeoutError("no ACK")
            if not ack.get("ok"):
                if ack.get("error") == "rate_limited":
                    # The per-user send budget (burst 20, 2/s) refused it. A real client backs off and retries the
                    # SAME clientMessageId; nothing was persisted, so this is not a retry of a delivered message.
                    throttled += 1
                    time.sleep(0.7)
                    continue
                check(f"message {i + 1} acknowledged ok", False, ack)
                sys.exit(1)
            if ack.get("duplicate"):
                duplicates_absorbed += 1
            if killed_at is not None and recovered_at is None:
                recovered_at = time.time()
            i += 1
        except Exception:
            # Exactly what the browser client does: keep the message, reconnect, resend the SAME clientMessageId.
            retried += 1
            s.close()
            s = connect_with_backoff(sender["token"])
            reconnects += 1
    s.close()

    gap = (recovered_at - killed_at) if (killed_at and recovered_at) else None
    check("the sender's replica was killed mid-stream and the client recovered", gap is not None)
    if gap is not None:
        print(f"      delivery gap felt by the sender: {gap:.1f} s  |  reconnects: {reconnects}  |  sends retried: {retried}"
              f"  |  retries the server answered duplicate:true: {duplicates_absorbed}  |  rate-limit backoffs: {throttled}")

    # Ground truth: what Postgres holds, read through the surviving replica.
    rows, before = [], None
    while True:
        path = f"/api/v1/chatrooms/{room_id}/messages?limit=50" + (f"&before={before}" if before else "")
        st, body = http("GET", path, None, observer["token"])
        assert st == 200, (st, body)
        page = body["messages"] if isinstance(body, dict) else body
        if not page:
            break
        rows.extend(page)
        more = isinstance(body, dict) and (body.get("cursor") or {}).get("hasMore")
        if not more:
            break
        before = min(m["sequenceNumber"] for m in page)
    rows.sort(key=lambda m: m["sequenceNumber"])
    got_ids = [m.get("clientMessageId") for m in rows]
    seqs = [m["sequenceNumber"] for m in rows]

    check(f"exactly {TOTAL} rows persisted (none lost, none duplicated)", len(rows) == TOTAL, f"{len(rows)} rows")
    check("no clientMessageId appears twice", len(set(got_ids)) == len(got_ids))
    check(f"sequence numbers are contiguous 1..{TOTAL}", seqs == list(range(1, TOTAL + 1)), seqs[:5] + ["..."] + seqs[-5:])
    check("persisted order equals send order", got_ids == ids)

    restore_replicas()
    print("      killed replica restarted")

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
