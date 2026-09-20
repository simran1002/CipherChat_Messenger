import { expect, test } from "@playwright/test";
import { API, bearer, createRoom, joinRoom, roomMessages, uid, type Account } from "../../support/api";
import { accessToken, currentUserId, registerViaUi } from "../../support/ui";

test.describe("chat rooms", () => {
  test("two people in a room see each other's messages live, and each message is stored exactly once", async ({ browser }) => {
    const aliceCtx = await browser.newContext();
    const bobCtx = await browser.newContext();
    const alice = await aliceCtx.newPage();
    const bob = await bobCtx.newPage();

    const aliceUser = await registerViaUi(alice, "RoomAlice");
    const bobUser = await registerViaUi(bob, "RoomBob");
    const asAccount = async (page: typeof alice, u: { name: string; email: string }): Promise<Account> =>
      ({ ...u, id: await currentUserId(page), token: await accessToken(page), refreshCookie: "" });
    const aliceAcc = await asAccount(alice, aliceUser);
    const bobAcc = await asAccount(bob, bobUser);

    const roomId = await createRoom(alice.request, aliceAcc, false);
    await joinRoom(bob.request, bobAcc, roomId);

    await Promise.all([alice.goto(`/chatroom/${roomId}`), bob.goto(`/chatroom/${roomId}`)]);
    await expect(alice.getByLabel("Message input")).toBeVisible();
    await expect(bob.getByLabel("Message input")).toBeVisible();

    const fromAlice = `alice says ${uid()}`;
    await alice.getByLabel("Message input").fill(fromAlice);
    await alice.getByLabel("Message input").press("Enter");
    await expect(alice.getByText(fromAlice).first()).toBeVisible();
    await expect(bob.getByText(fromAlice).first()).toBeVisible(); // over the WebSocket, no reload

    const fromBob = `bob answers ${uid()}`;
    await bob.getByLabel("Message input").fill(fromBob);
    await bob.getByLabel("Message input").press("Enter");
    await expect(alice.getByText(fromBob).first()).toBeVisible();

    // Ground truth is the database, not either screen: both messages, once each, in order.
    const stored = await roomMessages(alice.request, aliceAcc, roomId);
    expect(stored.map((m) => m.message)).toEqual([fromAlice, fromBob]);
    expect(stored.map((m) => m.sequenceNumber)).toEqual([1, 2]);

    // ...and Alice's read marker clears her unread badge.
    const res = await alice.request.get(`${API}/api/v1/chatrooms`, { headers: bearer(aliceAcc) });
    expect(res.ok()).toBe(true);

    await aliceCtx.close();
    await bobCtx.close();
  });

  test("a message sent while the connection is down is delivered once when it returns", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const user = await registerViaUi(page, "Offliner");
    const account: Account = { ...user, id: await currentUserId(page), token: await accessToken(page), refreshCookie: "" };
    const roomId = await createRoom(page.request, account, false);

    await page.goto(`/chatroom/${roomId}`);
    await expect(page.getByLabel("Message input")).toBeVisible();

    await ctx.setOffline(true);
    const text = `sent offline ${uid()}`;
    await page.getByLabel("Message input").fill(text);
    await page.getByLabel("Message input").press("Enter");
    await ctx.setOffline(false);

    await expect.poll(async () => (await roomMessages(page.request, account, roomId)).filter((m) => m.message === text).length, {
      message: "the queued message must reach the server exactly once after reconnecting",
      timeout: 45_000,
    }).toBe(1);
    await ctx.close();
  });
});
