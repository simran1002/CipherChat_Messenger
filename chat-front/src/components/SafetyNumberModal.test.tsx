import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AxiosError, type AxiosResponse } from "axios";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SafetyNumberModal from "./SafetyNumberModal";
import e2eeService from "../services/E2EEService";
import { makeToast } from "../utils/toast";

vi.mock("../services/E2EEService", () => ({
  default: {
    safetyNumberFor: vi.fn(),
    markVerified: vi.fn(),
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

const PEER_ID = "user-bob";
const PEER_NAME = "Bob";

// 60 decimal digits → formatSafetyNumber() renders 12 groups of 5
const DIGITS = "012345678998765432101122334455667788990001112223334445556667";
const FORMATTED = DIGITS.match(/.{1,5}/g)!.join(" ");
const FIVE_DIGITS = /^\d{5}$/;

/** The real isNoKeysError() requires an AxiosError 404 whose body carries code "no_keys". */
function noKeysError(): AxiosError {
  const response = { status: 404, statusText: "Not Found", data: { code: "no_keys" } } as AxiosResponse;
  return new AxiosError("Request failed with status code 404", "ERR_BAD_REQUEST", undefined, undefined, response);
}

function renderModal(onClose = vi.fn()) {
  render(<SafetyNumberModal peerId={PEER_ID} peerName={PEER_NAME} onClose={onClose} />);
  return { onClose };
}

describe("SafetyNumberModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    expect(DIGITS).toHaveLength(60);
  });

  it("renders the 60-digit safety number as 12 groups of 5 with a 'Not verified' badge", async () => {
    service.safetyNumberFor.mockResolvedValueOnce({ digits: DIGITS, formatted: FORMATTED, verified: false });
    renderModal();

    expect(screen.getByText("Safety Number")).toBeVisible();
    expect(screen.getByText(`with ${PEER_NAME}`)).toBeVisible();

    const groups = await screen.findAllByText(FIVE_DIGITS);
    expect(groups).toHaveLength(12);
    expect(groups.map((g) => g.textContent).join(" ")).toBe(FORMATTED);
    expect(groups.map((g) => g.textContent).join("")).toBe(DIGITS);

    expect(service.safetyNumberFor).toHaveBeenCalledWith(PEER_ID);
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(screen.queryByText("Verified")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /mark as verified/i })).toBeEnabled();
  });

  it("'Mark as verified' calls markVerified(peerId), flips the badge and hides the button", async () => {
    service.safetyNumberFor.mockResolvedValueOnce({ digits: DIGITS, formatted: FORMATTED, verified: false });
    service.markVerified.mockResolvedValueOnce(undefined);
    renderModal();
    await screen.findAllByText(FIVE_DIGITS);

    fireEvent.click(screen.getByRole("button", { name: /mark as verified/i }));

    await waitFor(() => expect(service.markVerified).toHaveBeenCalledWith(PEER_ID));
    expect(await screen.findByText("Verified")).toBeVisible();
    expect(screen.queryByText("Not verified")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /mark as verified/i })).not.toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith("success", `${PEER_NAME} marked as verified`);
    // Digits are still shown after verifying
    expect(screen.getAllByText(FIVE_DIGITS)).toHaveLength(12);
  });

  it("markVerified failure toasts an error and keeps 'Not verified'", async () => {
    service.safetyNumberFor.mockResolvedValueOnce({ digits: DIGITS, formatted: FORMATTED, verified: false });
    service.markVerified.mockRejectedValueOnce(new Error("idb write failed"));
    renderModal();
    await screen.findAllByText(FIVE_DIGITS);

    fireEvent.click(screen.getByRole("button", { name: /mark as verified/i }));

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("error", "Failed to save verification"));
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(screen.getByRole("button", { name: /mark as verified/i })).toBeEnabled();
  });

  it("already-verified peers render the 'Verified' badge with no mark button", async () => {
    service.safetyNumberFor.mockResolvedValueOnce({ digits: DIGITS, formatted: FORMATTED, verified: true });
    renderModal();

    expect(await screen.findByText("Verified")).toBeVisible();
    expect(screen.queryByRole("button", { name: /mark as verified/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(FIVE_DIGITS)).toHaveLength(12);
  });

  it("peer without published keys (404 code=no_keys) → explanatory message, no digits", async () => {
    service.safetyNumberFor.mockRejectedValueOnce(noKeysError());
    renderModal();

    expect(
      await screen.findByText(/Bob hasn't enabled end-to-end encryption yet, so there is no safety number/)
    ).toBeVisible();
    expect(screen.queryAllByText(FIVE_DIGITS)).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /mark as verified/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't compute/i)).not.toBeInTheDocument();
  });

  it("a plain 404 without the no_keys code is treated as a generic error, not 'no keys'", async () => {
    const response = { status: 404, statusText: "Not Found", data: { message: "nope" } } as AxiosResponse;
    service.safetyNumberFor.mockRejectedValueOnce(
      new AxiosError("404", "ERR_BAD_REQUEST", undefined, undefined, response)
    );
    renderModal();

    expect(await screen.findByText(/couldn't compute the safety number right now/i)).toBeVisible();
    expect(screen.queryByText(/hasn't enabled end-to-end encryption/)).not.toBeInTheDocument();
  });

  it("local identity missing (service resolves null) → generic error message", async () => {
    service.safetyNumberFor.mockResolvedValueOnce(null);
    renderModal();

    expect(await screen.findByText(/couldn't compute the safety number right now/i)).toBeVisible();
    expect(screen.queryAllByText(FIVE_DIGITS)).toHaveLength(0);
  });

  it("close button and backdrop click call onClose; clicks inside the card do not", async () => {
    service.safetyNumberFor.mockResolvedValueOnce({ digits: DIGITS, formatted: FORMATTED, verified: true });
    const { onClose } = renderModal();
    await screen.findByText("Verified");

    fireEvent.click(screen.getByText("Safety Number")); // inside the card → stopPropagation
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    // Backdrop is the outermost fixed overlay
    const backdrop = screen.getByText("Safety Number").closest(".fixed");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
