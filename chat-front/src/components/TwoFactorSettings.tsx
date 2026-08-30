import { useEffect, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import {
  ShieldCheckIcon,
  ClipboardDocumentIcon,
  CheckIcon,
} from "@heroicons/react/24/outline";
import { makeToast } from "../utils/toast";
import api from "../services/api";

type Flow =
  | { step: "idle" }
  | { step: "qr"; otpauthUrl: string; secret: string; qrDataUrl: string | null }
  | { step: "codes"; backupCodes: string[] }
  | { step: "disable" };

interface TwoFactorSettingsProps {
  initialEnabled: boolean;
}

const errMessage = (err: unknown): string | undefined =>
  (err as { response?: { data?: { message?: string } } })?.response?.data?.message;

/**
 * Two-factor authentication card for the profile page.
 * Enable: setup (QR + manual secret) → confirm with a live code → backup
 * codes shown exactly once. Disable: password + current code.
 */
const TwoFactorSettings = ({ initialEnabled }: TwoFactorSettingsProps) => {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [flow, setFlow] = useState<Flow>({ step: "idle" });
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => setEnabled(initialEnabled), [initialEnabled]);

  const startSetup = async () => {
    setBusy(true);
    try {
      const res = await api.post("/user/2fa/setup", {});
      const { otpauthUrl, secret } = res.data as { otpauthUrl: string; secret: string };
      let qrDataUrl: string | null = null;
      try {
        qrDataUrl = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
      } catch {
        /* manual-entry fallback below still works */
      }
      setCode("");
      setFlow({ step: "qr", otpauthUrl, secret, qrDataUrl });
    } catch (err) {
      makeToast("error", errMessage(err) || "Could not start 2FA setup");
    } finally {
      setBusy(false);
    }
  };

  const confirmEnable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api.post("/user/2fa/enable", { code });
      const { backupCodes } = res.data as { backupCodes: string[] };
      setEnabled(true);
      setFlow({ step: "codes", backupCodes });
      makeToast("success", "Two-factor authentication enabled");
    } catch (err) {
      makeToast("error", errMessage(err) || "That code didn't match");
    } finally {
      setBusy(false);
    }
  };

  const confirmDisable = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post("/user/2fa/disable", { password, code });
      setEnabled(false);
      setFlow({ step: "idle" });
      setPassword("");
      setCode("");
      makeToast("success", "Two-factor authentication disabled");
    } catch (err) {
      makeToast("error", errMessage(err) || "Could not disable 2FA");
    } finally {
      setBusy(false);
    }
  };

  const copyCodes = async (codes: string[]) => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      makeToast("error", "Copy failed — write them down instead");
    }
  };

  const inputClass =
    "w-full bg-gray-700 border border-gray-600 focus:border-violet-500 rounded-xl px-4 py-2.5 text-sm text-gray-200 outline-none";

  return (
    <div className="bg-gray-800/60 border border-gray-700/50 rounded-2xl p-6 mt-6">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className={`w-5 h-5 ${enabled ? "text-green-400" : "text-gray-500"}`} />
          <h3 className="text-white font-semibold">Two-factor authentication</h3>
        </div>
        <span
          className={`text-xs px-2 py-0.5 rounded-full border ${
            enabled
              ? "text-green-300 border-green-500/40 bg-green-500/10"
              : "text-gray-400 border-gray-600 bg-gray-700/40"
          }`}
        >
          {enabled ? "Enabled" : "Off"}
        </span>
      </div>
      <p className="text-sm text-gray-400 mb-4">
        A stolen password alone won&apos;t open this account: signing in also requires a 6-digit
        code from an authenticator app on your device.
      </p>

      {flow.step === "idle" && !enabled && (
        <button
          onClick={startSetup}
          disabled={busy}
          className="px-4 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm text-white transition-colors disabled:opacity-60"
        >
          {busy ? "Preparing…" : "Enable two-factor authentication"}
        </button>
      )}

      {flow.step === "idle" && enabled && (
        <button
          onClick={() => {
            setPassword("");
            setCode("");
            setFlow({ step: "disable" });
          }}
          className="px-4 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-300 transition-colors"
        >
          Disable…
        </button>
      )}

      {flow.step === "qr" && (
        <form onSubmit={confirmEnable} className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-5 items-center sm:items-start">
            {flow.qrDataUrl && (
              <img
                src={flow.qrDataUrl}
                alt="Scan this QR code with your authenticator app"
                className="rounded-xl bg-white p-1.5 w-[180px] h-[180px]"
              />
            )}
            <div className="flex-1 space-y-3">
              <p className="text-sm text-gray-300">
                Scan with any TOTP authenticator (Aegis, Google Authenticator, 1Password…), or
                enter the secret manually:
              </p>
              <code className="block bg-gray-900/70 border border-gray-700 rounded-lg px-3 py-2 text-xs text-violet-300 break-all select-all">
                {flow.secret}
              </code>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={6}
                placeholder="Enter the 6-digit code to confirm"
                aria-label="Confirmation code"
                className={inputClass}
                required
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFlow({ step: "idle" })}
              className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy || code.trim().length < 6}
              className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm text-white transition-colors disabled:opacity-60"
            >
              {busy ? "Verifying…" : "Turn on"}
            </button>
          </div>
        </form>
      )}

      {flow.step === "codes" && (
        <div className="space-y-4">
          <p className="text-sm text-amber-300/90">
            Save these single-use backup codes — they are shown only once and are the only way in
            if you lose your authenticator.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {flow.backupCodes.map((c) => (
              <code
                key={c}
                className="bg-gray-900/70 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-center text-gray-200 font-mono"
              >
                {c}
              </code>
            ))}
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => void copyCodes(flow.backupCodes)}
              className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-300 transition-colors flex items-center justify-center gap-1.5"
            >
              {copied ? <CheckIcon className="w-4 h-4 text-green-400" /> : <ClipboardDocumentIcon className="w-4 h-4" />}
              {copied ? "Copied" : "Copy all"}
            </button>
            <button
              onClick={() => setFlow({ step: "idle" })}
              className="flex-1 py-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-sm text-white transition-colors"
            >
              I saved my backup codes
            </button>
          </div>
        </div>
      )}

      {flow.step === "disable" && (
        <form onSubmit={confirmDisable} className="space-y-3">
          <p className="text-sm text-gray-400">
            Confirm with your password and a current code (or a backup code).
          </p>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            aria-label="Password"
            className={inputClass}
            required
          />
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Authenticator or backup code"
            aria-label="Two-factor code"
            className={inputClass}
            required
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setFlow({ step: "idle" })}
              className="flex-1 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-300 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 py-2.5 bg-red-600/80 hover:bg-red-600 rounded-xl text-sm text-white transition-colors disabled:opacity-60"
            >
              {busy ? "Disabling…" : "Disable 2FA"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};

export default TwoFactorSettings;
