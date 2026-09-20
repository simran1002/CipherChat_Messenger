import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { API, bearer, uid } from "../../support/api";
import { accessToken, bubble, conversationIdWith, enableEncryption, registerViaUi, sendDm, startDm, type UiUser } from "../../support/ui";

/**
 * The product's headline promise, end to end with two real browsers: what one user types is readable by the
 * other, and the server only ever holds ciphertext. One serial scenario — each step builds on the last.
 */
test.describe.serial("end-to-end encrypted direct messages", () => {
  let aliceCtx: BrowserContext, bobCtx: BrowserContext;
  let alice: Page, bob: Page;
  let aliceUser: UiUser, bobUser: UiUser;
  const marker = `quokka${uid()}`; // one indexable word, unique to this run
  const first = `hello bob ${marker}`;
  const reply = `hello alice, got it ${uid()}`;
  const second = `second message on a ratchet ${uid()}`;

  test.beforeAll(async ({ browser }) => {
    aliceCtx = await browser.newContext();
    bobCtx = await browser.newContext();
    alice = await aliceCtx.newPage();
    bob = await bobCtx.newPage();
  });

  test.afterAll(async () => {
    await aliceCtx.close();
    await bobCtx.close();
  });

  test("both users register and enable end-to-end encryption", async () => {
    aliceUser = await registerViaUi(alice, "Alice");
    bobUser = await registerViaUi(bob, "Bob");
    await enableEncryption(alice);
    await enableEncryption(bob); // Bob must publish keys before Alice writes, or she would have nobody to encrypt to
  });

  test("Alice writes to Bob, and the server stores ciphertext only", async () => {
    await startDm(alice, bobUser);
    await sendDm(alice, bobUser.name, first);
    await expect(bubble(alice, first)).toBeVisible();

    // The bubble appears optimistically; the ground truth is what the server persists, so wait for that.
    const conversationId = await conversationIdWith(alice, bobUser.id);
    const token = await accessToken(alice);
    const fetchRaw = async () =>
      (await alice.request.get(`${API}/api/v1/conversations/${conversationId}/messages`, { headers: bearer({ token }) })).text();
    await expect.poll(async () => (JSON.parse(await fetchRaw()) as { messages: unknown[] }).messages.length, { timeout: 20_000 }).toBe(1);

    const raw = await fetchRaw();
    expect(raw, "the server's copy must not contain the plaintext").not.toContain(marker);
    const { messages } = JSON.parse(raw) as { messages: { type: string; envelope?: { v: number; ct: string } }[] };
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: "e2ee/v1", envelope: { v: 1 } });
    expect(messages[0]!.envelope!.ct.length).toBeGreaterThan(20);
  });

  test("Bob reads it, replies, and Alice receives the reply live", async () => {
    await bob.reload(); // a brand-new inbound conversation appears in the sidebar after a refresh
    await bob.getByText(aliceUser.name).first().click();
    await expect(bubble(bob, first)).toBeVisible();

    await sendDm(bob, aliceUser.name, reply);
    await expect(bubble(alice, reply)).toBeVisible(); // Alice's pane was already open: delivered and decrypted over the socket
  });

  test("the encryption status panel tells the truth, and upgrading really switches protocols", async () => {
    await alice.getByRole("button", { name: "Encryption status" }).click();
    await expect(alice.getByText("Session-protected (v1)")).toBeVisible();
    await expect(alice.getByText(/every message in the/i)).toBeVisible(); // the honest v1 exposure statement

    await alice.getByRole("button", { name: /start a double ratchet session/i }).click();
    await expect(alice.getByText("Session-protected (v1)")).toHaveCount(0); // modal closed

    await sendDm(alice, bobUser.name, second);
    await expect(bubble(alice, second)).toBeVisible();
    await expect(bubble(bob, second)).toBeVisible(); // Bob's device answers the v2 handshake on its own

    await alice.getByRole("button", { name: "Encryption status" }).click();
    await expect(alice.getByText("Double Ratchet", { exact: true })).toBeVisible();
    await expect(alice.getByText(/none of the \d+/i)).toBeVisible();
    await alice.getByRole("button", { name: "Close" }).click();
  });

  test("Ctrl+K searches every conversation on this device and jumps to the result", async () => {
    await alice.keyboard.press("Control+k");
    const box = alice.getByLabel("Search all direct messages");
    await expect(box).toBeVisible();

    await box.fill(marker);
    const hit = alice.locator("button", { hasText: bobUser.name }).filter({ hasText: marker });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(box).toHaveCount(0);
  });

  test("shredding a conversation destroys its readable history on this device", async () => {
    alice.once("dialog", (d) => void d.accept());
    await alice.getByRole("button", { name: "Shred this conversation on this device" }).click();
    await expect(alice.getByText(marker)).toHaveCount(0);

    await alice.reload();
    await alice.getByText(bobUser.name).first().click();
    await expect(alice.getByText(/Unable to decrypt|Not stored on this device/).first()).toBeVisible();
    await expect(alice.getByText(marker)).toHaveCount(0);

    // Bob's own copy is untouched: shredding is a local guarantee, not a remote wipe.
    await expect(bubble(bob, first)).toBeVisible();
  });
});
