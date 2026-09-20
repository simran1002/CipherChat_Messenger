import { expect, test } from "@playwright/test";
import { PASSWORD } from "../../support/api";
import { loginViaUi, registerViaUi, signOut } from "../../support/ui";

test.describe("public pages", () => {
  test("the landing page describes the Java stack and makes no stale Node-era claims", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /proves its guarantees/i })).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).toContain("Java 21");
    for (const stale of ["Socket.IO", "MongoDB", "285 automated"]) expect(text, `landing page still says "${stale}"`).not.toContain(stale);
  });

  test("an unknown route shows the 404 page with a way home", async ({ page }) => {
    await page.goto("/definitely-not-a-page");
    await expect(page.getByText("This page does not exist.")).toBeVisible();
    await page.getByRole("link", { name: "Back to home" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("protected pages send an anonymous visitor to the sign-in page", async ({ page }) => {
    for (const path of ["/dashboard", "/messages", "/profile"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login$/);
    }
  });
});

test.describe("account lifecycle", () => {
  test("registering signs you in immediately — no reload needed to see the signed-in app", async ({ page }) => {
    const user = await registerViaUi(page, "Newcomer");

    // The header must already reflect the session: this used to stay logged-out until a manual refresh.
    await expect(page.getByRole("link", { name: "Direct messages" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sign Up" })).toHaveCount(0);
    expect(user.id).not.toBe("");
  });

  test("sign out, then wrong password is refused, then the right one signs back in", async ({ page }) => {
    const user = await registerViaUi(page, "Returner");
    await signOut(page);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);

    await loginViaUi(page, user.email, "not-the-password");
    await expect(page.getByText("Email and password did not match.")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    await loginViaUi(page, user.email, PASSWORD);
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  });

  test("a session survives a full page reload", async ({ page }) => {
    await registerViaUi(page, "Persistent");
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("button", { name: "Account menu" })).toBeVisible();
  });
});
