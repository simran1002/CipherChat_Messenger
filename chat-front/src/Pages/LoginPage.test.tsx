import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./LoginPage";
import api from "../services/api";

vi.mock("../services/api", () => ({
  default: { post: vi.fn() },
  apiErrorMessage: (err: unknown, fallback: string) =>
    (err as { response?: { data?: { detail?: string; message?: string } } })?.response?.data?.detail ||
    (err as { response?: { data?: { detail?: string; message?: string } } })?.response?.data?.message ||
    fallback,
}));
vi.mock("../utils/toast", () => ({ makeToast: vi.fn() }));
const setupSocket = vi.fn();
vi.mock("../contexts/SocketContext", () => ({
  useSocket: () => ({ socket: null, setupSocket, teardownSocket: vi.fn() }),
}));

const post = vi.mocked(api.post);

const USER = { id: "u1", name: "Priya", email: "p@x.dev" };

function renderLogin() {
  const setUser = vi.fn();
  render(
    <MemoryRouter>
      <LoginPage setUser={setUser} />
    </MemoryRouter>
  );
  return { setUser };
}

function submitPassword() {
  fireEvent.change(screen.getByPlaceholderText("Enter your email"), { target: { value: "p@x.dev" } });
  fireEvent.change(screen.getByPlaceholderText("Enter your password"), { target: { value: "pw" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
}

describe("LoginPage two-factor step", () => {
  beforeEach(() => {
    post.mockReset();
    setupSocket.mockReset();
    localStorage.clear();
  });

  it("logs straight in when the account has no 2FA", async () => {
    post.mockResolvedValueOnce({ data: { message: "ok", token: "jwt-access", user: USER } });
    const { setUser } = renderLogin();
    submitPassword();

    await waitFor(() => expect(setUser).toHaveBeenCalledWith(USER));
    expect(localStorage.getItem("CC_Token")).toBe("jwt-access");
    expect(setupSocket).toHaveBeenCalled();
  });

  it("requires2fa switches to the code step WITHOUT storing any token", async () => {
    post.mockResolvedValueOnce({ data: { requires2fa: true, pendingToken: "pending.jwt" } });
    const { setUser } = renderLogin();
    submitPassword();

    await waitFor(() => expect(screen.getByText("Two-factor authentication")).toBeInTheDocument());
    expect(localStorage.getItem("CC_Token")).toBeNull(); // the password alone is not a session
    expect(setUser).not.toHaveBeenCalled();

    // Second step: code → /api/v1/auth/login/2fa with the pending token
    post.mockResolvedValueOnce({ data: { message: "ok", token: "jwt-after-2fa", user: USER } });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(setUser).toHaveBeenCalledWith(USER));
    expect(post).toHaveBeenLastCalledWith("/api/v1/auth/login/2fa", { pendingToken: "pending.jwt", code: "123456" });
    expect(localStorage.getItem("CC_Token")).toBe("jwt-after-2fa");
  });

  it("an expired pending token sends the user back to the password step", async () => {
    post.mockResolvedValueOnce({ data: { requires2fa: true, pendingToken: "stale.jwt" } });
    renderLogin();
    submitPassword();
    await waitFor(() => expect(screen.getByLabelText("Two-factor code")).toBeInTheDocument());

    post.mockRejectedValueOnce({
      response: { status: 401, data: { message: "Sign-in expired", code: "2fa_pending_invalid" } },
    });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "111111" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => expect(screen.getByPlaceholderText("Enter your password")).toBeInTheDocument());
    expect(localStorage.getItem("CC_Token")).toBeNull();
  });

  it("'Back to password' abandons the pending sign-in", async () => {
    post.mockResolvedValueOnce({ data: { requires2fa: true, pendingToken: "p" } });
    renderLogin();
    submitPassword();
    await waitFor(() => expect(screen.getByRole("button", { name: "Back to password" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Back to password" }));
    expect(screen.getByPlaceholderText("Enter your password")).toBeInTheDocument();
  });
});
