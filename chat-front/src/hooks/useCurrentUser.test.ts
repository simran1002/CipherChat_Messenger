import { afterEach, describe, expect, it } from "vitest";
import { getCurrentUserId, getStoredUser } from "./useCurrentUser";

function makeToken(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return [header, btoa(JSON.stringify(payload)), "fake-signature"].join(".");
}

afterEach(() => {
  localStorage.clear();
});

describe("getCurrentUserId", () => {
  it("returns the id from a valid JWT payload", () => {
    localStorage.setItem("CC_Token", makeToken({ id: "user-42", iat: 1700000000 }));
    expect(getCurrentUserId()).toBe("user-42");
  });

  it("returns null when the payload has no id", () => {
    localStorage.setItem("CC_Token", makeToken({ sub: "someone-else" }));
    expect(getCurrentUserId()).toBeNull();
  });

  it("returns null for a token with no payload part", () => {
    localStorage.setItem("CC_Token", "not-a-jwt");
    expect(getCurrentUserId()).toBeNull();
  });

  it("returns null for a token with a corrupt payload part", () => {
    localStorage.setItem("CC_Token", "header.%%%not-base64%%%.signature");
    expect(getCurrentUserId()).toBeNull();
  });

  it("returns null when no token is stored", () => {
    expect(getCurrentUserId()).toBeNull();
  });
});

describe("getStoredUser", () => {
  it("parses a stored user object", () => {
    const user = { id: "user-42", name: "Ada", email: "ada@example.com" };
    localStorage.setItem("CC_User", JSON.stringify(user));
    expect(getStoredUser()).toEqual(user);
  });

  it("returns null for corrupt JSON", () => {
    localStorage.setItem("CC_User", "{not valid json");
    expect(getStoredUser()).toBeNull();
  });

  it("returns null when no user is stored", () => {
    expect(getStoredUser()).toBeNull();
  });
});
