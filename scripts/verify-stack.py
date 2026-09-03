#!/usr/bin/env python3
"""
End-to-end verification of a running CipherChat stack (docker compose up).

    python scripts/verify-stack.py                      # against http://localhost:8080
    BASE_URL=http://localhost:8080 python scripts/verify-stack.py --chaos   # + Redis/Kafka failure drills

Each check prints PASS/FAIL and the script exits non-zero on any failure, so it
doubles as a smoke test in CI-like environments. The --chaos drills use
`docker compose pause/unpause redis` and `docker compose stop/start kafka`, so
they need the Compose project running on this machine.

What it asserts (the documented contract, not the code):
  1. liveness/readiness are UP; /actuator/health reports db, redis and kafka contributors
  2. register → JWT → /users/me; wrong password → 401 problem+json with code
  3. room create → send with clientMessageId → 201 seq 1 → same id again → duplicate:true, same messageId
  4. private room → outsider 403 on history and send
  5. DM: start (symmetric) → E2EE envelope 201 → same (session, ctr) under a new client id → 409 replayed_counter
  6. mention → notification row arrives through Kafka (outbox → consumer)
  7. [--chaos] Redis paused: rate limiter fails open (register still 201), room send → 503 redis_unavailable,
     DM send still 201 (no sequence needed); unpause → sends resume with gapless sequences
  8. [--chaos] Kafka stopped: send still 201 and outbox has an incomplete publication; start → outbox drains
     and the mention notification appears
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = os.environ.get("BASE_URL", "http://localhost:8080").rstrip("/")
PASSWORD = "correct horse battery staple"
results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"  -- {detail}"))
    return ok


def http(method, path, body=None, token=None, headers=None, raw=False):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            payload = r.read()
            return r.status, (payload if raw else (json.loads(payload) if payload else None)), dict(r.headers)
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload), dict(e.headers)
        except Exception:
            return e.code, payload.decode(errors="replace"), dict(e.headers)
    except Exception as e:  # connection refused etc.
        return 0, str(e), {}


def register(tag):
    email = f"verify-{tag}-{uuid.uuid4()}@stack.test"
    st, body, _ = http("POST", "/api/v1/auth/register", {"name": f"Verify {tag}", "email": email, "password": PASSWORD})
    if st != 201:
        raise SystemExit(f"register failed: {st} {body}")
    return {"token": body["token"], "id": body["user"]["id"], "email": email}


def compose(*args):
    cmd = ["docker", "compose", *args]
    return subprocess.run(cmd, capture_output=True, text=True, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def psql(sql):
    r = compose("exec", "-T", "postgres", "psql", "-U", "cipherchat", "-d", "cipherchat", "-tAc", sql)
    return r.stdout.strip()


def wait_until(pred, timeout, every=1.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if pred():
                return True
        except Exception:
            pass
        time.sleep(every)
    return False


def envelope(session, ctr):
    return {"v": 1, "sessionId": session, "ctr": ctr, "ct": "A" * 344}  # 256 zero bytes, base64


def main():
    chaos = "--chaos" in sys.argv

    # 1. health
    st, live, _ = http("GET", "/actuator/health/liveness")
    check("liveness UP", st == 200 and live.get("status") == "UP", f"{st} {live}")
    st, ready, _ = http("GET", "/actuator/health/readiness")
    check("readiness UP", st == 200 and ready.get("status") == "UP", f"{st} {ready}")
    st, health, _ = http("GET", "/actuator/health")
    check("health UP", st == 200 and health.get("status") == "UP", f"{st} {health}")

    # 2. auth
    alice = register("alice")
    bob = register("bob")
    eve = register("eve")
    st, me, _ = http("GET", "/api/v1/users/me", token=alice["token"])
    check("GET /users/me with JWT", st == 200 and me.get("email") == alice["email"], f"{st} {me}")
    st, bad, hdr = http("POST", "/api/v1/auth/login", {"email": alice["email"], "password": "nope"})
    check("wrong password → 401 problem+json bad_credentials",
          st == 401 and isinstance(bad, dict) and bad.get("code") == "bad_credentials"
          and "problem+json" in hdr.get("Content-Type", ""), f"{st} {bad}")
    st, _, _ = http("GET", "/api/v1/users/me")
    check("no token → 401", st == 401, str(st))

    # 3. exactly-once send
    st, room, _ = http("POST", "/api/v1/chatrooms", {"name": f"verify-{uuid.uuid4().hex[:8]}", "isPrivate": False}, alice["token"])
    check("create room 201", st == 201, f"{st} {room}")
    room_id = room["id"]
    http("POST", f"/api/v1/chatrooms/{room_id}/join", None, bob["token"])
    cid = str(uuid.uuid4())
    st, first, _ = http("POST", f"/api/v1/chatrooms/{room_id}/messages", {"message": "hello", "clientMessageId": cid}, alice["token"])
    check("send → 201 seq 1", st == 201 and first.get("sequenceNumber") == 1 and first.get("duplicate") is False, f"{st} {first}")
    st, retry, _ = http("POST", f"/api/v1/chatrooms/{room_id}/messages", {"message": "hello", "clientMessageId": cid}, alice["token"])
    check("same clientMessageId → duplicate:true, same messageId, seq 1",
          st == 201 and retry.get("duplicate") is True and retry.get("messageId") == first.get("messageId") and retry.get("sequenceNumber") == 1,
          f"{st} {retry}")
    rows = psql(f"select count(*) from messages where client_message_id = '{cid}'")
    check("exactly one row in messages for that client id", rows == "1", rows)

    # 4. private room authorization
    st, priv, _ = http("POST", "/api/v1/chatrooms", {"name": f"private-{uuid.uuid4().hex[:8]}", "isPrivate": True}, alice["token"])
    st, _, _ = http("GET", f"/api/v1/chatrooms/{priv['id']}/messages", token=eve["token"])
    check("outsider GET private history → 403", st == 403, str(st))
    st, _, _ = http("POST", f"/api/v1/chatrooms/{priv['id']}/messages", {"message": "x"}, eve["token"])
    check("outsider POST private message → 403", st == 403, str(st))

    # 5. DM replay backstop
    st, conv, _ = http("POST", "/api/v1/conversations", {"targetUserId": bob["id"]}, alice["token"])
    st2, conv2, _ = http("POST", "/api/v1/conversations", {"targetUserId": alice["id"]}, bob["token"])
    check("conversation get-or-create is symmetric", st == 201 and st2 == 201 and conv["id"] == conv2["id"], f"{conv} {conv2}")
    session = str(uuid.uuid4())
    st, sent, _ = http("POST", f"/api/v1/conversations/{conv['id']}/messages", {"clientMessageId": str(uuid.uuid4()), "envelope": envelope(session, 0)}, alice["token"])
    check("E2EE envelope accepted 201", st == 201 and sent["message"]["type"] == "e2ee/v1", f"{st} {sent}")
    st, replay, _ = http("POST", f"/api/v1/conversations/{conv['id']}/messages", {"clientMessageId": str(uuid.uuid4()), "envelope": envelope(session, 0)}, alice["token"])
    check("replayed (session, ctr) → 409 replayed_counter", st == 409 and replay.get("code") == "replayed_counter", f"{st} {replay}")
    st, _, _ = http("GET", f"/api/v1/conversations/{conv['id']}/messages", token=eve["token"])
    check("non-participant DM history → 403", st == 403, str(st))

    # 6. Kafka path: mention → durable notification
    st, m, _ = http("POST", f"/api/v1/chatrooms/{room_id}/messages", {"message": "hey @bob", "mentions": [bob["id"]]}, alice["token"])
    check("mention send 201", st == 201, f"{st} {m}")
    def has_notification():
        s, inbox, _ = http("GET", "/api/v1/notifications", token=bob["token"])
        return s == 200 and any(n.get("type") == "mention" and n["payload"].get("messageId") == m["messageId"] for n in inbox)
    check("mention notification arrives via Kafka (≤ 45 s)", wait_until(has_notification, 45), "no inbox row")
    ledger = psql("select count(*) from processed_events where consumer='notifications'")
    check("processed_events ledger has claims", ledger.isdigit() and int(ledger) >= 1, ledger)

    if chaos:
        print("\n--- chaos: Redis paused ---")
        compose("pause", "redis")
        try:
            time.sleep(1)
            st, _, _ = http("POST", "/api/v1/auth/register", {"name": "During Redis Outage", "email": f"outage-{uuid.uuid4()}@stack.test", "password": PASSWORD})
            check("[redis down] register still works (rate limiter fails open)", st == 201, str(st))
            st, body, _ = http("POST", f"/api/v1/chatrooms/{room_id}/messages", {"message": "during outage"}, alice["token"])
            check("[redis down] room send → 503 redis_unavailable (fails closed, retryable)",
                  st == 503 and isinstance(body, dict) and body.get("code") in ("redis_unavailable", "dependency_unavailable"), f"{st} {body}")
            st, body, _ = http("POST", f"/api/v1/conversations/{conv['id']}/messages", {"envelope": envelope(session, 1)}, alice["token"])
            check("[redis down] DM send still 201 (no sequence needed; dedup via unique index)", st == 201, f"{st} {body}")
            st, ready, _ = http("GET", "/actuator/health/readiness")
            check("[redis down] readiness reports DOWN", st == 503 and ready.get("status") == "DOWN", f"{st} {ready}")
        finally:
            compose("unpause", "redis")
        check("[redis back] readiness UP again (≤ 30 s)", wait_until(lambda: http("GET", "/actuator/health/readiness")[0] == 200, 30))
        st, after, _ = http("POST", f"/api/v1/chatrooms/{room_id}/messages", {"message": "after outage"}, alice["token"])
        check("[redis back] send resumes", st == 201, f"{st} {after}")
        seqs = psql(f"select string_agg(sequence_number::text, ',' order by sequence_number) from messages where chatroom_id='{room_id}'")
        expected = ",".join(str(i) for i in range(1, int(after["sequenceNumber"]) + 1))
        check("[redis back] sequences gapless 1..N", seqs == expected, f"{seqs} != {expected}")

        print("\n--- chaos: Kafka stopped ---")
        compose("stop", "kafka")
        try:
            time.sleep(2)
            st, m2, _ = http("POST", f"/api/v1/chatrooms/{room_id}/messages", {"message": "mention while kafka down @bob", "mentions": [bob["id"]]}, alice["token"])
            check("[kafka down] send still 201 (outbox absorbs it)", st == 201, f"{st} {m2}")
            st, ready, _ = http("GET", "/actuator/health/readiness")
            check("[kafka down] readiness still UP (Kafka does not gate readiness)", st == 200, f"{st} {ready}")
            st, health, _ = http("GET", "/actuator/health")
            check("[kafka down] /actuator/health reports DOWN overall", st == 503, f"{st} {health}")
            pending = psql("select count(*) from event_publication where completion_date is null")
            check("[kafka down] outbox holds incomplete publication(s)", pending.isdigit() and int(pending) >= 1, pending)
        finally:
            compose("start", "kafka")
        def drained():
            return psql("select count(*) from event_publication where completion_date is null") == "0"
        check("[kafka back] outbox drains (≤ 120 s)", wait_until(drained, 120, 2), psql("select count(*) from event_publication where completion_date is null"))
        def has_second():
            s, inbox, _ = http("GET", "/api/v1/notifications", token=bob["token"])
            return s == 200 and any(n["payload"].get("messageId") == m2["messageId"] for n in inbox)
        check("[kafka back] the mention sent during the outage becomes a notification (≤ 60 s)", wait_until(has_second, 60, 2))

    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(failed))
        sys.exit(1)


if __name__ == "__main__":
    main()
