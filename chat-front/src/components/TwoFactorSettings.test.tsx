import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TwoFactorSettings from "./TwoFactorSettings";
import api from "../services/api";
import { makeToast } from "../utils/toast";

vi.mock("../services/api", () => ({ default: { post: vi.fn() } }));
vi.mock("../utils/toast", () => ({ makeToast: vi.fn() }));
// qrcode draws to a canvas — irrelevant here, return a stable data URL
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,QR") },
}));

const post = vi.mocked(api.post);
const toast = vi.mocked(makeToast);

const BACKUP_CODES = ["A2B3-C4D5", "E6F7-G8H9", "J2K3-M4N5", "P6Q7-R8S9", "T2V3-W4X5", "Y6Z7-A8B9", "C2D3-E4F5", "G6H7-J8K9"];

describe("TwoFactorSettings", () => {
  beforeEach(() => {
    post.mockReset();
    toast.mockReset();
  });

  it("shows Off state with an enable button when 2FA is disabled", () => {
    render(<TwoFactorSettings initialEnabled={false} />);
    expect(screen.getByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable two-factor authentication" })).toBeInTheDocument();
  });

  it("enable flow: setup → QR + manual secret → live code → backup codes shown once", async () => {
    post
      .mockResolvedValueOnce({
        data: { otpauthUrl: "otpauth://totp/CipherChat:me?secret=JBSWY3DP", secret: "JBSWY3DP" },
      })
      .mockResolvedValueOnce({ data: { backupCodes: BACKUP_CODES } });

    render(<TwoFactorSettings initialEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor authentication" }));

    // QR step: image + manual-entry secret + confirmation input
    await waitFor(() => expect(screen.getByText("JBSWY3DP")).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith("/user/2fa/setup", {});
    expect(screen.getByAltText(/Scan this QR code/)).toHaveAttribute("src", "data:image/png;base64,QR");

    fireEvent.change(screen.getByLabelText("Confirmation code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

    // Backup codes step — all 8, plus the status flipping to Enabled
    await waitFor(() => expect(screen.getByText(BACKUP_CODES[0])).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith("/user/2fa/enable", { code: "123456" });
    for (const code of BACKUP_CODES) expect(screen.getByText(code)).toBeInTheDocument();
    expect(screen.getByText("Enabled")).toBeInTheDocument();

    // Codes are dismissed explicitly — never shown again
    fireEvent.click(screen.getByRole("button", { name: "I saved my backup codes" }));
    expect(screen.queryByText(BACKUP_CODES[0])).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Disable…" })).toBeInTheDocument();
  });

  it("a rejected confirmation code keeps 2FA off and surfaces the server message", async () => {
    post
      .mockResolvedValueOnce({ data: { otpauthUrl: "otpauth://x", secret: "S" } })
      .mockRejectedValueOnce({ response: { data: { message: "That code didn't match — check your authenticator app." } } });

    render(<TwoFactorSettings initialEnabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Enable two-factor authentication" }));
    await waitFor(() => expect(screen.getByLabelText("Confirmation code")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Confirmation code"), { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith("error", "That code didn't match — check your authenticator app.")
    );
    expect(screen.getByText("Off")).toBeInTheDocument();
  });

  it("disable flow requires password + code and flips the card back to Off", async () => {
    post.mockResolvedValueOnce({ data: { message: "disabled" } });

    render(<TwoFactorSettings initialEnabled={true} />);
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Disable…" }));

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.change(screen.getByLabelText("Two-factor code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable 2FA" }));

    await waitFor(() => expect(screen.getByText("Off")).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith("/user/2fa/disable", { password: "pw", code: "654321" });
  });
});
