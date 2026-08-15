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
    const payload = JSON.parse(atob(payloadPart)) as { id?: string };
    return payload.id ?? null;
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
