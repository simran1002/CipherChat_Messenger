import { expect, type Page } from "@playwright/test";
import { API, PASSWORD, bearer, uid } from "./api";

export interface UiUser {
  name: string;
  email: string;
  id: string;
}

/** Register through the real form and wait until the app shows the signed-in dashboard. */
export async function registerViaUi(page: Page, tag: string): Promise<UiUser> {
  const name = `${tag}${uid()}`;
  const email = `${tag.toLowerCase()}-${uid()}@e2e.test`;
  await page.goto("/register");
  await page.getByPlaceholder("Choose a username").fill(name);
  await page.getByPlaceholder("Enter your email").fill(email);
  await page.getByPlaceholder("Create a password (min 6 characters)").fill(PASSWORD);
  await page.getByPlaceholder("Confirm your password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create Account" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  return { name, email, id: await currentUserId(page) };
}

export async function loginViaUi(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("Enter your email").fill(email);
  await page.getByPlaceholder("Enter your password").fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("button", { name: "Sign Out" }).click();
  await expect(page.getByRole("link", { name: "Sign Up" })).toBeVisible();
}

export async function currentUserId(page: Page): Promise<string> {
  return page.evaluate(() => (JSON.parse(localStorage.getItem("CC_User") ?? "{}") as { id?: string }).id ?? "");
}

export async function accessToken(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem("CC_Token") ?? "");
}

export async function deviceOwner(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("CC_DeviceOwner"));
}

/** Walk the first-run encryption gate on /messages: enable, acknowledge the recovery code, land in the inbox. */
export async function enableEncryption(page: Page): Promise<string> {
  await page.goto("/messages");
  await page.getByRole("button", { name: "Enable encryption" }).click();
  const code = (await page.getByText(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){7}$/).first().textContent())?.trim() ?? "";
  expect(code, "a recovery code is shown exactly once").not.toBe("");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "I saved my recovery code" }).click();
  await expect(page.getByRole("button", { name: "New direct message" })).toBeVisible();
  return code;
}

/** Open a new conversation with someone by email from the inbox's "new message" picker. */
export async function startDm(page: Page, with_: UiUser): Promise<void> {
  await page.getByRole("button", { name: "New direct message" }).click();
  await page.getByPlaceholder("Search users…").fill(with_.name);
  await page.locator("button", { hasText: with_.email }).click();
  await expect(composer(page, with_.name)).toBeVisible();
}

export function composer(page: Page, peerName: string) {
  return page.getByPlaceholder(new RegExp(`^Message ${peerName}`));
}

export async function sendDm(page: Page, peerName: string, text: string): Promise<void> {
  const box = composer(page, peerName);
  await box.fill(text);
  await box.press("Enter");
}

/** A message bubble with this text somewhere in the conversation pane. */
export function bubble(page: Page, text: string) {
  return page.getByText(text).first();
}

/** The conversation id between the signed-in user and someone, straight from the API. */
export async function conversationIdWith(page: Page, peerId: string): Promise<string> {
  const token = await accessToken(page);
  const res = await page.request.get(`${API}/api/v1/conversations`, { headers: bearer({ token }) });
  expect(res.ok()).toBe(true);
  const list = (await res.json()) as { id: string; participant?: { id: string } }[];
  const found = list.find((c) => c.participant?.id === peerId);
  expect(found, "conversation exists on the server").toBeTruthy();
  return found!.id;
}
