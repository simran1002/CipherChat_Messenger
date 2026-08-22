/**
 * Blocking interstitial for the E2EE identity lifecycle, rendered inside
 * DirectMessagesPage (the rest of the app is unaffected).
 *
 *  - "needs-setup"            → enable → show one-time recovery code → confirm saved
 *  - "needs-restore-or-reset" → restore with code, or danger-confirmed reset
 *  - "unavailable"            → non-blocking warning banner + children (legacy sends)
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  ArrowPathIcon,
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
  KeyIcon,
  LockClosedIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { makeToast } from "../utils/toast";
import e2eeService from "../services/E2EEService";

interface E2EESetupGateProps {
  status: "needs-setup" | "needs-restore-or-reset" | "unavailable";
  /** Failure detail when status is "unavailable". */
  reason?: string;
  /** Called once the identity is ready (after setup/restore/reset completes). */
  onReady: () => void;
  /** Rendered beneath the warning banner when status is "unavailable". */
  children?: ReactNode;
}

type GateView = "intro" | "restore" | "reset-confirm" | "show-code";

const CODE_PLACEHOLDER = "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX";

const E2EESetupGate = ({ status, reason, onReady, children }: E2EESetupGateProps) => {
  const [view, setView] = useState<GateView>("intro");
  const [busy, setBusy] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [restoreInput, setRestoreInput] = useState("");
  const [restoreError, setRestoreError] = useState("");
  // The recovery code is shown exactly once — require an explicit
  // acknowledgement before the continue button can dismiss it.
  const [savedAck, setSavedAck] = useState(false);

  if (status === "unavailable") {
    return (
      <div className="flex flex-col h-full min-h-0">
        <div className="flex items-center gap-3 bg-amber-500/10 border-b border-amber-500/30 px-4 py-2.5">
          <ExclamationTriangleIcon className="w-5 h-5 text-amber-400 shrink-0" />
          <p className="text-xs text-amber-300">
            End-to-end encryption is unavailable{reason ? ` (${reason})` : ""}. Messages will be
            sent unencrypted until it recovers.
          </p>
        </div>
        <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      </div>
    );
  }

  const enableEncryption = async () => {
    setBusy(true);
    try {
      const code = await e2eeService.setUp();
      setRecoveryCode(code);
      setView("show-code");
    } catch {
      makeToast("error", "Failed to enable encryption. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const submitRestore = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!restoreInput.trim()) return;
    setBusy(true);
    setRestoreError("");
    try {
      await e2eeService.restore(restoreInput);
      makeToast("success", "Encryption restored");
      onReady();
    } catch {
      setRestoreError("Recovery code incorrect");
    } finally {
      setBusy(false);
    }
  };

  const confirmReset = async () => {
    setBusy(true);
    try {
      const code = await e2eeService.reset();
      setRecoveryCode(code);
      setView("show-code");
    } catch {
      makeToast("error", "Failed to reset encryption. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(recoveryCode);
      makeToast("success", "Recovery code copied");
    } catch {
      makeToast("error", "Copy failed — select the code and copy it manually");
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center h-full bg-gray-900 p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="bg-gray-800/50 backdrop-blur-xl rounded-2xl border border-gray-700/50 shadow-2xl w-full max-w-md p-8"
      >
        {view === "show-code" ? (
          <>
            <div className="w-14 h-14 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-primary-500/25">
              <KeyIcon className="w-7 h-7 text-white" />
            </div>
            <h2 className="text-xl font-bold text-white text-center mb-2">Save your recovery code</h2>
            <p className="text-sm text-gray-400 text-center mb-5">
              This code is shown <span className="text-white font-medium">only once</span>. It is
              the only way to restore your encrypted messages on a new device or browser. Store it
              somewhere safe, like a password manager.
            </p>
            <div className="relative bg-gray-900/80 border border-gray-700 rounded-xl p-4 mb-4">
              <code className="block font-mono text-sm text-primary-300 break-all leading-relaxed select-all">
                {recoveryCode}
              </code>
              <button
                onClick={copyCode}
                className="absolute top-2 right-2 p-1.5 text-gray-500 hover:text-white bg-gray-800 rounded-lg transition-colors"
                aria-label="Copy recovery code"
              >
                <ClipboardDocumentIcon className="w-4 h-4" />
              </button>
            </div>
            <label className="flex items-start gap-3 mb-4 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={savedAck}
                onChange={(e) => setSavedAck(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-gray-600 bg-gray-900 text-primary-500 focus:ring-primary-500"
                aria-label="I have written this code down or stored it in a password manager"
              />
              <span className="text-sm text-gray-300">
                I have written this code down or stored it in a password manager. I understand it
                will not be shown again.
              </span>
            </label>
            <button
              onClick={onReady}
              disabled={!savedAck}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white text-sm font-medium transition-all shadow-lg shadow-primary-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              I saved my recovery code
            </button>
          </>
        ) : status === "needs-setup" ? (
          <>
            <div className="w-14 h-14 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-primary-500/25">
              <LockClosedIcon className="w-7 h-7 text-white" />
            </div>
            <h2 className="text-xl font-bold text-white text-center mb-2">
              Enable end-to-end encryption
            </h2>
            <p className="text-sm text-gray-400 text-center mb-2">
              Direct messages in CipherChat are end-to-end encrypted: they are locked on your
              device and only you and your contact hold the keys. Not even the server can read
              them.
            </p>
            <p className="text-sm text-gray-400 text-center mb-6">
              Setup takes a moment and gives you a recovery code for signing in on new devices.
            </p>
            <button
              onClick={enableEncryption}
              disabled={busy}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2 transition-all shadow-lg shadow-primary-500/20"
            >
              {busy ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Generating keys…
                </>
              ) : (
                <>
                  <ShieldCheckIcon className="w-4 h-4" /> Enable encryption
                </>
              )}
            </button>
          </>
        ) : view === "reset-confirm" ? (
          <>
            <div className="w-14 h-14 bg-red-500/20 rounded-2xl flex items-center justify-center mx-auto mb-5">
              <ExclamationTriangleIcon className="w-7 h-7 text-red-400" />
            </div>
            <h2 className="text-xl font-bold text-white text-center mb-2">Reset encryption?</h2>
            <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 mb-6">
              <p className="text-sm text-red-300">
                Previous encrypted messages will become unreadable; contacts will see a
                safety-code-changed notice.
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setView("intro")}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl border border-gray-600 text-gray-300 hover:text-white hover:border-gray-500 text-sm font-medium transition-all"
              >
                Cancel
              </button>
              <button
                onClick={confirmReset}
                disabled={busy}
                className="flex-1 py-2.5 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
              >
                {busy ? (
                  <>
                    <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    Resetting…
                  </>
                ) : (
                  "Reset encryption"
                )}
              </button>
            </div>
          </>
        ) : view === "restore" ? (
          <>
            <div className="w-14 h-14 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-primary-500/25">
              <KeyIcon className="w-7 h-7 text-white" />
            </div>
            <h2 className="text-xl font-bold text-white text-center mb-2">Restore encryption</h2>
            <p className="text-sm text-gray-400 text-center mb-5">
              Enter the recovery code you saved when you first enabled encryption.
            </p>
            <form onSubmit={submitRestore}>
              <input
                type="text"
                value={restoreInput}
                onChange={(e) => {
                  setRestoreInput(e.target.value);
                  setRestoreError("");
                }}
                placeholder={CODE_PLACEHOLDER}
                autoFocus
                spellCheck={false}
                autoComplete="off"
                className="w-full bg-gray-700/50 border border-gray-600 text-white font-mono rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-600 transition-all mb-2"
              />
              {restoreError && <p className="text-xs text-red-400 mb-2">{restoreError}</p>}
              <div className="flex gap-3 mt-3">
                <button
                  type="button"
                  onClick={() => setView("intro")}
                  disabled={busy}
                  className="flex-1 py-2.5 rounded-xl border border-gray-600 text-gray-300 hover:text-white hover:border-gray-500 text-sm font-medium transition-all"
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={busy || !restoreInput.trim()}
                  className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white text-sm font-medium disabled:opacity-40 flex items-center justify-center gap-2 transition-all"
                >
                  {busy ? (
                    <>
                      <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Restoring…
                    </>
                  ) : (
                    "Restore"
                  )}
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="w-14 h-14 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg shadow-primary-500/25">
              <LockClosedIcon className="w-7 h-7 text-white" />
            </div>
            <h2 className="text-xl font-bold text-white text-center mb-2">
              Encryption keys not found on this device
            </h2>
            <p className="text-sm text-gray-400 text-center mb-6">
              You have end-to-end encryption enabled, but this browser has no copy of your keys.
              Restore them with your recovery code, or reset encryption to start over.
            </p>
            <button
              onClick={() => setView("restore")}
              className="w-full py-3 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white text-sm font-medium flex items-center justify-center gap-2 transition-all shadow-lg shadow-primary-500/20 mb-3"
            >
              <KeyIcon className="w-4 h-4" /> Restore encryption
            </button>
            <button
              onClick={() => setView("reset-confirm")}
              className="w-full py-3 rounded-xl border border-red-500/40 text-red-400 hover:bg-red-500/10 hover:border-red-500/60 text-sm font-medium flex items-center justify-center gap-2 transition-all"
            >
              <ArrowPathIcon className="w-4 h-4" /> Reset encryption
            </button>
          </>
        )}
      </motion.div>
    </div>
  );
};

export default E2EESetupGate;
