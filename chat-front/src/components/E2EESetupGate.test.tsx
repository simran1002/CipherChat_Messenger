import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import E2EESetupGate from "./E2EESetupGate";
import e2eeService, { type E2EEStatus } from "../services/E2EEService";
import { useE2EEGate } from "../hooks/useE2EE";
import { makeToast } from "../utils/toast";
import type { StoredIdentity } from "../crypto/keyStore";

// The gate talks to the E2EEService singleton only; mock the whole module so
// no IndexedDB / network / real key generation happens in these tests.
vi.mock("../services/E2EEService", () => ({
  default: {
    ensureReady: vi.fn(),
    setUp: vi.fn(),
    restore: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock("../utils/toast", () => ({ makeToast: vi.fn() }));

// framer-motion applies `opacity: 0` inline on mount (animated away via rAF),
// which breaks `toBeVisible` in jsdom — render plain elements instead.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  const MOTION_ONLY = new Set([
    "initial", "animate", "exit", "transition", "variants", "layout", "layoutId",
    "whileHover", "whileTap", "whileFocus", "whileDrag", "whileInView", "viewport",
    "drag", "dragConstraints", "onAnimationStart", "onAnimationComplete",
  ]);
  type AnyProps = Record<string, unknown>;
  const cache = new Map<string, React.ComponentType<AnyProps>>();
  const motion = new Proxy({} as Record<string, React.ComponentType<AnyProps>>, {
    get(_target, prop: string | symbol) {
      const tag = String(prop);
      let component = cache.get(tag);
      if (!component) {
        const Plain = React.forwardRef<HTMLElement, AnyProps>((props, ref) => {
          const domProps: AnyProps = { ref };
          for (const [k, v] of Object.entries(props)) if (!MOTION_ONLY.has(k)) domProps[k] = v;
          return React.createElement(tag, domProps);
        });
        Plain.displayName = `motion.${tag}`;
        component = Plain as unknown as React.ComponentType<AnyProps>;
        cache.set(tag, component);
      }
      return component;
    },
  });
  const AnimatePresence = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return { motion, AnimatePresence };
});

const service = vi.mocked(e2eeService);
const toastMock = vi.mocked(makeToast);

const RECOVERY_CODE = "K7PW-9XQ2-3MZD-8FJT-5HNB-2RVC-6YSW-4GAE";

/** A promise whose settlement the test controls — for "busy" state assertions. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const CHILD_TEST_ID = "gated-children";
const Children = () => <div data-testid={CHILD_TEST_ID}>chat ui</div>;

describe("E2EESetupGate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("status = needs-setup", () => {
    it("shows the intro with an 'Enable encryption' button and does NOT render children", () => {
      render(
        <E2EESetupGate status="needs-setup" onReady={vi.fn()}>
          <Children />
        </E2EESetupGate>
      );

      expect(screen.getByRole("heading", { name: "Enable end-to-end encryption" })).toBeVisible();
      expect(screen.getByRole("button", { name: /enable encryption/i })).toBeEnabled();
      expect(screen.queryByTestId(CHILD_TEST_ID)).not.toBeInTheDocument();
      expect(screen.queryByText(/recovery code/i, { selector: "h2" })).not.toBeInTheDocument();
    });

    it("enable → busy state → recovery code shown; onReady only fires after the user confirms they saved it", async () => {
      const pending = deferred<string>();
      service.setUp.mockReturnValueOnce(pending.promise);
      const onReady = vi.fn();
      render(<E2EESetupGate status="needs-setup" onReady={onReady} />);

      fireEvent.click(screen.getByRole("button", { name: /enable encryption/i }));

      // Busy: button disabled with progress label while keys generate
      const busyButton = await screen.findByRole("button", { name: /generating keys/i });
      expect(busyButton).toBeDisabled();
      expect(service.setUp).toHaveBeenCalledTimes(1);

      pending.resolve(RECOVERY_CODE);

      // Code view: the one-time recovery code is rendered verbatim
      expect(await screen.findByRole("heading", { name: "Save your recovery code" })).toBeVisible();
      expect(screen.getByText(RECOVERY_CODE)).toBeVisible();
      expect(screen.getByText(RECOVERY_CODE).tagName).toBe("CODE");

      // Nothing has been acknowledged yet → the gate must still be up
      expect(onReady).not.toHaveBeenCalled();

      // The continue button is gated behind an explicit acknowledgement —
      // one accidental click must not dismiss a code that is shown only once
      const confirm = screen.getByRole("button", { name: "I saved my recovery code" });
      expect(confirm).toBeDisabled();
      fireEvent.click(confirm);
      expect(onReady).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("checkbox", { name: /written this code down/i }));
      expect(confirm).toBeEnabled();
      fireEvent.click(confirm);
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it("copy button writes the code to the clipboard and toasts", async () => {
      service.setUp.mockResolvedValueOnce(RECOVERY_CODE);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<E2EESetupGate status="needs-setup" onReady={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /enable encryption/i }));
      await screen.findByText(RECOVERY_CODE);

      fireEvent.click(screen.getByRole("button", { name: "Copy recovery code" }));

      await waitFor(() => expect(writeText).toHaveBeenCalledWith(RECOVERY_CODE));
      await waitFor(() => expect(toastMock).toHaveBeenCalledWith("success", "Recovery code copied"));
    });

    it("setUp failure toasts an error and stays on the intro", async () => {
      service.setUp.mockRejectedValueOnce(new Error("boom"));
      const onReady = vi.fn();
      render(<E2EESetupGate status="needs-setup" onReady={onReady} />);

      fireEvent.click(screen.getByRole("button", { name: /enable encryption/i }));

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith("error", "Failed to enable encryption. Please try again.")
      );
      expect(screen.getByRole("button", { name: /enable encryption/i })).toBeEnabled();
      expect(screen.queryByText("Save your recovery code")).not.toBeInTheDocument();
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe("status = needs-restore-or-reset", () => {
    it("shows the restore and reset entry points", () => {
      render(<E2EESetupGate status="needs-restore-or-reset" onReady={vi.fn()} />);

      expect(
        screen.getByRole("heading", { name: "Encryption keys not found on this device" })
      ).toBeVisible();
      expect(screen.getByRole("button", { name: /restore encryption/i })).toBeVisible();
      expect(screen.getByRole("button", { name: /reset encryption/i })).toBeVisible();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("restore: input + submit (disabled until typed); success calls service.restore(code) and onReady", async () => {
      service.restore.mockResolvedValueOnce(undefined);
      const onReady = vi.fn();
      render(<E2EESetupGate status="needs-restore-or-reset" onReady={onReady} />);

      fireEvent.click(screen.getByRole("button", { name: /restore encryption/i }));

      const input = screen.getByPlaceholderText("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX");
      expect(input).toBeVisible();
      const submit = screen.getByRole("button", { name: "Restore" });
      expect(submit).toBeDisabled();

      fireEvent.change(input, { target: { value: "   " } });
      expect(submit).toBeDisabled();

      fireEvent.change(input, { target: { value: RECOVERY_CODE } });
      expect(submit).toBeEnabled();
      fireEvent.click(submit);

      await waitFor(() => expect(service.restore).toHaveBeenCalledWith(RECOVERY_CODE));
      await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
      expect(toastMock).toHaveBeenCalledWith("success", "Encryption restored");
    });

    it("restore with a wrong code shows an inline error and keeps the gate up", async () => {
      service.restore.mockRejectedValueOnce(new Error("Recovery code incorrect or backup corrupted"));
      const onReady = vi.fn();
      render(<E2EESetupGate status="needs-restore-or-reset" onReady={onReady} />);

      fireEvent.click(screen.getByRole("button", { name: /restore encryption/i }));
      const input = screen.getByPlaceholderText("XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX");
      fireEvent.change(input, { target: { value: "WRONG-CODE" } });
      fireEvent.click(screen.getByRole("button", { name: "Restore" }));

      expect(await screen.findByText("Recovery code incorrect")).toBeVisible();
      expect(onReady).not.toHaveBeenCalled();

      // Typing again clears the error
      fireEvent.change(input, { target: { value: "WRONG-CODE-2" } });
      expect(screen.queryByText("Recovery code incorrect")).not.toBeInTheDocument();

      // Back returns to the intro
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("heading", { name: "Encryption keys not found on this device" })).toBeVisible();
    });

    it("reset: danger confirm → service.reset() → new recovery code → confirm → onReady", async () => {
      service.reset.mockResolvedValueOnce(RECOVERY_CODE);
      const onReady = vi.fn();
      render(<E2EESetupGate status="needs-restore-or-reset" onReady={onReady} />);

      fireEvent.click(screen.getByRole("button", { name: /reset encryption/i }));

      expect(screen.getByRole("heading", { name: "Reset encryption?" })).toBeVisible();
      expect(screen.getByText(/previous encrypted messages will become unreadable/i)).toBeVisible();
      expect(service.reset).not.toHaveBeenCalled();

      // Cancel goes back without touching the service
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(screen.getByRole("heading", { name: "Encryption keys not found on this device" })).toBeVisible();
      expect(service.reset).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: /reset encryption/i }));
      fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));

      expect(await screen.findByText(RECOVERY_CODE)).toBeVisible();
      expect(service.reset).toHaveBeenCalledTimes(1);
      expect(onReady).not.toHaveBeenCalled();

      // Same acknowledgement gate as first-time setup
      fireEvent.click(screen.getByRole("checkbox", { name: /written this code down/i }));
      fireEvent.click(screen.getByRole("button", { name: "I saved my recovery code" }));
      expect(onReady).toHaveBeenCalledTimes(1);
    });

    it("reset failure toasts and returns to an actionable state", async () => {
      service.reset.mockRejectedValueOnce(new Error("boom"));
      render(<E2EESetupGate status="needs-restore-or-reset" onReady={vi.fn()} />);

      fireEvent.click(screen.getByRole("button", { name: /reset encryption/i }));
      fireEvent.click(screen.getByRole("button", { name: "Reset encryption" }));

      await waitFor(() =>
        expect(toastMock).toHaveBeenCalledWith("error", "Failed to reset encryption. Please try again.")
      );
      expect(screen.getByRole("button", { name: "Reset encryption" })).toBeEnabled();
    });
  });

  describe("status = unavailable", () => {
    it("renders a warning banner AND the children (legacy unencrypted sends)", () => {
      render(
        <E2EESetupGate status="unavailable" reason="keys/me 503" onReady={vi.fn()}>
          <Children />
        </E2EESetupGate>
      );

      expect(screen.getByText(/end-to-end encryption is unavailable \(keys\/me 503\)/i)).toBeVisible();
      expect(screen.getByText(/sent unencrypted until it recovers/i)).toBeVisible();
      expect(screen.getByTestId(CHILD_TEST_ID)).toBeVisible();
      expect(screen.queryByRole("button", { name: /enable encryption/i })).not.toBeInTheDocument();
    });

    it("omits the parenthetical when no reason is given", () => {
      render(<E2EESetupGate status="unavailable" onReady={vi.fn()} />);
      expect(screen.getByText(/End-to-end encryption is unavailable\. Messages/)).toBeInTheDocument();
    });
  });
});

/**
 * "ready" is not a gate state: DirectMessagesPage reads useE2EE()/useE2EEGate()
 * and only mounts the gate for the three non-ready states. Pin that contract
 * at the hook level so the page can rely on `ready` to skip the gate entirely.
 */
describe("useE2EEGate (drives whether the gate is mounted at all)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const identity = { edPub: "pub" } as unknown as StoredIdentity;

  it("starts loading, then reports ready=true when the service resolves 'ready'", async () => {
    service.ensureReady.mockResolvedValueOnce({ state: "ready", identity } satisfies E2EEStatus);

    const { result } = renderHook(() => useE2EEGate());
    expect(result.current.ready).toBe(false);
    expect(result.current.status.state).toBe("loading");

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.status).toEqual({ state: "ready", identity });
  });

  it("reports ready=false with the concrete non-ready state the gate should render", async () => {
    service.ensureReady.mockResolvedValueOnce({ state: "needs-setup" });

    const { result } = renderHook(() => useE2EEGate());
    await waitFor(() => expect(result.current.status.state).toBe("needs-setup"));
    expect(result.current.ready).toBe(false);
  });

  it("maps a thrown ensureReady() into 'unavailable' with the error message as reason", async () => {
    service.ensureReady.mockRejectedValueOnce(new Error("IndexedDB blocked"));

    const { result } = renderHook(() => useE2EEGate());
    await waitFor(() => expect(result.current.status.state).toBe("unavailable"));
    expect(result.current.status).toEqual({ state: "unavailable", reason: "IndexedDB blocked" });
    expect(result.current.ready).toBe(false);
  });

  it("refresh() re-runs the state machine (setup gate → onReady → refresh → ready)", async () => {
    service.ensureReady
      .mockResolvedValueOnce({ state: "needs-setup" })
      .mockResolvedValueOnce({ state: "ready", identity });

    const { result } = renderHook(() => useE2EEGate());
    await waitFor(() => expect(result.current.status.state).toBe("needs-setup"));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(service.ensureReady).toHaveBeenCalledTimes(2);
  });
});
