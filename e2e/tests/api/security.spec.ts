import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { API, PASSWORD, WEB, bearer, cookiePair, createRoom, joinRoom, registerApi, roomMessages, sendRoomMessage, setCookies, uid } from "../../support/api";
import { StompClient } from "../../support/stomp";

test.describe("STOMP gateway: clients speak to /app only", () => {
  test("a signed-in outsider cannot forge a room message or another user's private event", async ({ request }) => {
    const owner = await registerApi(request, "Forge Owner");
    const eve = await registerApi(request, "Forge Eve");
    const room = await createRoom(request, owner, true); // private: eve is not even a member

    const victim = await StompClient.connect(owner.token);
    victim.subscribe(`/topic/rooms/${room}`);
    victim.subscribe("/user/queue/events");
    await new Promise((r) => setTimeout(r, 500));

    // A refused SEND makes the broker drop that session, so each forgery gets a fresh connection.
    const forgeRoom = await StompClient.connect(eve.token);
    forgeRoom.send(`/topic/rooms/${room}`, { event: "newMessage", payload: { message: "FORGED BY EVE", name: owner.name } });
    const forgeQueue = await StompClient.connect(eve.token);
    forgeQueue.send(`/user/${owner.id}/queue/events`, { event: "dmNotification", payload: { from: "FORGED" } });

    // Unrelated traffic (presence events) may legitimately arrive; a FORGED frame must not.
    const seen = await victim.collect(3_000);
    expect(JSON.stringify(seen), "a forged frame reached the victim").not.toContain("FORGED");

    // The broker answered the attacker with an ERROR frame rather than relaying anything.
    const refusal = await forgeRoom.next(3_000);
    expect(refusal === null || refusal.command === "ERROR").toBe(true);

    // The legitimate path is unaffected.
    const legit = await StompClient.connect(owner.token);
    legit.send("/app/rooms/send", { chatroomId: room, message: "genuine", clientMessageId: randomUUID() });
    const real = await victim.waitFor((m) => m.event === "newMessage", 10_000);
    expect(real, "the genuine message never arrived").not.toBeNull();
    expect(JSON.stringify(real)).toContain("genuine");

    for (const c of [victim, forgeRoom, forgeQueue, legit]) c.close();
  });

  test("an outsider is refused a subscription to a private room", async ({ request }) => {
    const owner = await registerApi(request, "Priv Owner");
    const outsider = await registerApi(request, "Priv Outsider");
    const room = await createRoom(request, owner, true);

    const eve = await StompClient.connect(outsider.token);
    eve.subscribe(`/topic/rooms/${room}`);

    // "No reply" alone can't tell a refusal from a silent success, so prove the outcome: the owner posts to the
    // room and the outsider must receive nothing of it.
    const secret = `members only ${uid()}`;
    await sendRoomMessage(request, owner, room, secret);
    const seen = await eve.collect(3_000);
    expect(JSON.stringify(seen), "an outsider received a private room's message").not.toContain(secret);
    eve.close();
  });

  test("CONNECT without a valid token is refused", async () => {
    await expect(StompClient.connect("not-a-token")).rejects.toThrow();
  });
});

test.describe("sessions: refresh-token rotation and reuse detection", () => {
  test("rotation issues a new cookie and a racing sibling tab is refused without revoking anything", async ({ playwright }) => {
    const anon = await playwright.request.newContext();
    const s = await registerApi(anon, "Rotator");

    const first = await anon.post(`${API}/api/v1/auth/refresh`, { headers: { Cookie: s.refreshCookie } });
    expect(first.status()).toBe(200);
    const rotated = cookiePair(first, "CC_Refresh");
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(s.refreshCookie);

    // Inside the grace window a replay looks like two tabs racing: refused, but no family-wide revocation.
    const racer = await anon.post(`${API}/api/v1/auth/refresh`, { headers: { Cookie: s.refreshCookie } });
    expect(racer.status()).toBe(401);
    const stillGood = await anon.post(`${API}/api/v1/auth/refresh`, { headers: { Cookie: rotated! } });
    expect(stillGood.status()).toBe(200);
    await anon.dispose();
  });

  test("replaying a stolen, already-rotated cookie revokes the whole family — the thief's live token too", async ({ playwright }) => {
    test.setTimeout(60_000);
    const anon = await playwright.request.newContext();
    const victim = await registerApi(anon, "Stolen");

    // The owner refreshes; the thief still holds the ORIGINAL cookie.
    const owner = await anon.post(`${API}/api/v1/auth/refresh`, { headers: { Cookie: victim.refreshCookie } });
    const ownersLive = cookiePair(owner, "CC_Refresh")!;
    await new Promise((r) => setTimeout(r, 11_000)); // out of the 10 s two-tab grace window

    const theft = await anon.post(`${API}/api/v1/auth/refresh`, { headers: { Cookie: victim.refreshCookie } });
    expect(theft.status()).toBe(401);
    expect(await theft.json()).toMatchObject({ code: "refresh_invalid" });
    expect(setCookies(theft).some((c) => c.startsWith("CC_Refresh=") && /Max-Age=0/i.test(c))).toBe(true);

    // The family is gone: even the legitimate owner's newest token no longer works.
    const afterwards = await anon.post(`${API}/api/v1/auth/refresh`, { headers: { Cookie: ownersLive } });
    expect(afterwards.status()).toBe(401);
    await anon.dispose();
  });
});

test.describe("login throttling", () => {
  test("guessing one account's password is cut off, without locking out anyone else", async ({ request }) => {
    const target = await registerApi(request, "Target");
    const bystander = await registerApi(request, "Bystander");

    let cutOffAt = 0;
    for (let attempt = 1; attempt <= 20; attempt++) {
      const res = await request.post(`${API}/api/v1/auth/login`, { data: { email: target.email, password: `wrong-${attempt}` } });
      if (res.status() === 429) {
        cutOffAt = attempt;
        expect(await res.json()).toMatchObject({ code: "rate_limited" });
        break;
      }
      expect(res.status()).toBe(401);
    }
    expect(cutOffAt, "throttle never engaged").toBeGreaterThan(0);
    expect(cutOffAt).toBeLessThanOrEqual(13);

    const correctButThrottled = await request.post(`${API}/api/v1/auth/login`, { data: { email: target.email, password: PASSWORD } });
    expect(correctButThrottled.status()).toBe(429);

    const other = await request.post(`${API}/api/v1/auth/login`, { data: { email: bystander.email, password: PASSWORD } });
    expect(other.status()).toBe(200);
  });
});

test.describe("uploads", () => {
  test("a file named .html but declared image/png is stored and served as a png, never as html", async ({ request }) => {
    const s = await registerApi(request, "Uploader");
    const res = await request.post(`${API}/api/v1/uploads`, {
      headers: bearer(s),
      multipart: { file: { name: "innocent.html", mimeType: "image/png", buffer: Buffer.from("<script>fetch('/api/v1/auth/refresh',{method:'POST'})</script>") } },
    });
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { url: string; fileName: string };
    expect(body.url).toMatch(/\.png$/);
    expect(body.fileName).toBe("innocent.html"); // display metadata only

    // The upload URL is absolute (the API origin) — the configured baseURL is the web app, which would answer with its SPA shell.
    const served = await request.get(body.url);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toContain("image/png");
    expect(served.headers()["x-content-type-options"]).toBe("nosniff");
  });

  test("html and svg are not on the allow-list", async ({ request }) => {
    const s = await registerApi(request, "Uploader Two");
    for (const [name, mimeType] of [["a.html", "text/html"], ["b.svg", "image/svg+xml"]] as const) {
      const res = await request.post(`${API}/api/v1/uploads`, { headers: bearer(s), multipart: { file: { name, mimeType, buffer: Buffer.from("<x/>") } } });
      expect(res.status(), `${mimeType} must be refused`).toBe(415);
    }
  });
});

test.describe("authorization and CORS", () => {
  test("protected endpoints reject anonymous callers", async ({ request }) => {
    for (const path of ["/api/v1/chatrooms", "/api/v1/conversations", "/api/v1/users/me", "/api/v1/notifications"]) {
      const res = await request.get(`${API}${path}`);
      expect([401, 403], `${path} was reachable without a token`).toContain(res.status());
    }
  });

  test("a regular user is refused the admin API", async ({ request }) => {
    const s = await registerApi(request, "Not Admin");
    const res = await request.get(`${API}/api/v1/admin/analytics/overview`, { headers: bearer(s) });
    expect(res.status()).toBe(403);
  });

  test("a private room's history and sending are closed to non-members", async ({ request }) => {
    const owner = await registerApi(request, "Room Owner");
    const outsider = await registerApi(request, "Room Outsider");
    const room = await createRoom(request, owner, true);
    expect((await request.get(`${API}/api/v1/chatrooms/${room}/messages`, { headers: bearer(outsider) })).status()).toBe(403);
    expect((await sendRoomMessage(request, outsider, room, "let me in")).status).toBe(403);
  });

  test("CORS allows the app's own origin and refuses a foreign one", async ({ request }) => {
    const allowed = await request.fetch(`${API}/api/v1/auth/login`, {
      method: "OPTIONS",
      headers: { Origin: WEB, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" },
    });
    expect(allowed.headers()["access-control-allow-origin"]).toBe(WEB);
    expect(allowed.headers()["access-control-allow-credentials"]).toBe("true");

    const foreign = await request.fetch(`${API}/api/v1/auth/login`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
    });
    expect(foreign.headers()["access-control-allow-origin"]).toBeUndefined();
  });
});

test.describe("exactly-once messaging under load", () => {
  test("client ids are scoped to a room: the same id elsewhere is a new message, never another room's content", async ({ request }) => {
    const alice = await registerApi(request, "Alice Scoped");
    const bob = await registerApi(request, "Bob Scoped");
    const aliceRoom = await createRoom(request, alice, true);
    const bobRoom = await createRoom(request, bob, true);
    const shared = randomUUID();

    const secret = await sendRoomMessage(request, alice, aliceRoom, "alice's confidential note", shared);
    expect(secret.status).toBe(201);
    const bobs = await sendRoomMessage(request, bob, bobRoom, "bob's own message", shared);

    expect(bobs.status).toBe(201);
    expect(bobs.body.duplicate).toBe(false);
    expect(bobs.body.sequenceNumber).toBe(1);
    expect(bobs.body.messageId).not.toBe(secret.body.messageId);
    expect(JSON.stringify(bobs.body)).not.toContain("confidential");
    expect((await roomMessages(request, bob, bobRoom)).map((m) => m.message)).toEqual(["bob's own message"]);
  });

  test("30 concurrent sends from 3 users get gapless sequences; re-sending every one is absorbed as a duplicate", async ({ request }) => {
    const users = await Promise.all(["Sender A", "Sender B", "Sender C"].map((n) => registerApi(request, n)));
    const room = await createRoom(request, users[0]!, false);
    await Promise.all(users.slice(1).map((u) => joinRoom(request, u, room)));

    const jobs = users.flatMap((u, ui) => Array.from({ length: 10 }, (_, i) => ({ user: u, text: `msg ${ui}-${i}`, id: randomUUID() })));

    const first = await Promise.all(jobs.map((j) => sendRoomMessage(request, j.user, room, j.text, j.id)));
    expect(first.every((r) => r.status === 201 && r.body.duplicate === false)).toBe(true);
    const sequences = first.map((r) => r.body.sequenceNumber!).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));

    // A flaky network re-delivers every request.
    const again = await Promise.all(jobs.map((j) => sendRoomMessage(request, j.user, room, j.text, j.id)));
    expect(again.every((r) => r.status === 201 && r.body.duplicate === true)).toBe(true);
    jobs.forEach((_, i) => expect(again[i]!.body.messageId).toBe(first[i]!.body.messageId));

    const history = await roomMessages(request, users[0]!, room);
    expect(history).toHaveLength(30);
    expect(new Set(history.map((m) => m.sequenceNumber)).size).toBe(30);
  });

  test("delta sync returns only what the client is missing, as JSON or CBOR", async ({ request }) => {
    const u = await registerApi(request, "Syncer");
    const room = await createRoom(request, u, false);
    for (let i = 0; i < 12; i++) await sendRoomMessage(request, u, room, `history line number ${i}`);

    const json = await request.post(`${API}/api/v1/sync/rooms`, { headers: { ...bearer(u), Accept: "application/json" }, data: { rooms: { [room]: 0 } } });
    const cbor = await request.post(`${API}/api/v1/sync/rooms`, { headers: { ...bearer(u), Accept: "application/cbor" }, data: { rooms: { [room]: 0 } } });
    expect(json.status()).toBe(200);
    expect(cbor.status()).toBe(200);
    expect(cbor.headers()["content-type"]).toContain("application/cbor");
    expect((await cbor.body()).length).toBeLessThan((await json.body()).length);

    const caughtUp = await request.post(`${API}/api/v1/sync/rooms`, { headers: bearer(u), data: { rooms: { [room]: 12 } } });
    expect(JSON.stringify(await caughtUp.json())).not.toContain("history line number");
  });
});

test.describe("AI gateway privacy", () => {
  test("identifiable data that survives client-side redaction is refused before any model call", async ({ request }) => {
    const u = await registerApi(request, "Redactor");
    const room = await createRoom(request, u, false);
    const res = await request.post(`${API}/api/v1/ai/summarize-redacted`, {
      headers: bearer(u),
      data: { scope: "room", scopeId: room, policyVersion: "pii-2026.09", entityCounts: {}, transcript: [{ who: "[PERSON_1]", text: `mail me at leak-${uid()}@corp.example` }] },
    });
    expect(res.status()).toBe(422);
    expect(await res.json()).toMatchObject({ code: "pii_detected" });
  });
});

test.describe("operability", () => {
  test("liveness and readiness are up and the OpenAPI document is served", async ({ request }) => {
    expect((await request.get(`${API}/actuator/health/liveness`)).status()).toBe(200);
    expect((await request.get(`${API}/actuator/health/readiness`)).status()).toBe(200);
    const docs = await request.get(`${API}/v3/api-docs`);
    expect(docs.status()).toBe(200);
    expect(Object.keys(((await docs.json()) as { paths: object }).paths).length).toBeGreaterThan(20);
  });
});
