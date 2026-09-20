import { expect, test } from "@playwright/test";
import { deviceOwner, enableEncryption, loginViaUi, registerViaUi, signOut } from "../../support/ui";

/**
 * Every E2EE store lives in the browser, keyed by conversation rather than by account, so signing out has to
 * be enough to stop the NEXT account on the same browser inheriting the first one's keys, decrypted history and
 * queued sends — including within a single tab, where an in-memory cache outlives the navigation.
 */
test.describe("one browser, several accounts", () => {
  test("a different account signing in never inherits the previous account's encryption identity", async ({ page }) => {
    const alice = await registerViaUi(page, "IsoAlice");
    await enableEncryption(page);
    expect(await deviceOwner(page)).toBe(alice.id);
    await signOut(page);

    // Same tab, no reload: the previous identity is still cached in memory unless sign-out drops it.
    const bob = await registerViaUi(page, "IsoBob");
    expect(await deviceOwner(page)).toBe(bob.id);
    await page.goto("/messages");
    await expect(page.getByRole("button", { name: "Enable encryption" }), "Bob must start with no identity of his own").toBeVisible();
    await expect(page.getByRole("button", { name: "New direct message" })).toHaveCount(0);
  });

  test("returning to a browser last used by someone else finds nothing of theirs — and must restore, not reuse", async ({ page }) => {
    const alice = await registerViaUi(page, "IsoAlice2");
    await enableEncryption(page);
    await signOut(page);
    await registerViaUi(page, "IsoBob2");
    await signOut(page);

    // Bob left no keys behind for Alice to pick up, and Alice's own were wiped when Bob took over the device.
    await loginViaUi(page, alice.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/messages");
    await expect(page.getByRole("button", { name: "New direct message" })).toHaveCount(0);
    await expect(page.getByText(/recovery code/i).first()).toBeVisible();
  });

  test("the SAME account signing out and back in keeps its keys — no needless re-setup", async ({ page }) => {
    const user = await registerViaUi(page, "IsoSame");
    await enableEncryption(page);
    await signOut(page);

    await loginViaUi(page, user.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/messages");
    await expect(page.getByRole("button", { name: "New direct message" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable encryption" })).toHaveCount(0);
  });
});
