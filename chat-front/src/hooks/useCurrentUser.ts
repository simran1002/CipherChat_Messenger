/**
 * Current user identity derived from stored credentials.
 * Replaces the hand-rolled JWT base64 decoding that was duplicated
 * across ChatroomPage and DirectMessagesPage.
 */
import { useMemo } from "react";
import type { AuthUser } from "../types";

export function getCurrentUserId(): string | null {
  const token = localStorage.getItem("CC_Token");
  if (!token) return null;
  try {
    const payloadPart = token.split(".")[1];
    if (!payloadPart) return null;
    // The Java backend's access token puts the user id in the standard `sub`
    // claim (JwtService.issueAccessToken), not a custom `id` claim.
    const payload = JSON.parse(atob(payloadPart)) as { sub?: string };
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem("CC_User");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

export function useCurrentUser(): { userId: string | null; user: AuthUser | null } {
  return useMemo(() => ({ userId: getCurrentUserId(), user: getStoredUser() }), []);
}
