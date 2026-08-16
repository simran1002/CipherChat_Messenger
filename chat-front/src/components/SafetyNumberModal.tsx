/**
 * Safety-number comparison modal. Shows the shared 60-digit fingerprint
 * (12 groups of 5) both parties can compare out-of-band, with a
 * "Mark as verified" flow persisted via the peer pin store.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckBadgeIcon, ShieldCheckIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { makeToast } from "../utils/toast";
import e2eeService from "../services/E2EEService";
import { isNoKeysError } from "../hooks/useE2EE";

interface SafetyNumberModalProps {
  peerId: string;
  peerName: string;
  onClose: () => void;
}

type ModalState =
  | { kind: "loading" }
  | { kind: "no-keys" }
  | { kind: "error" }
  | { kind: "loaded"; formatted: string; verified: boolean };

const SafetyNumberModal = ({ peerId, peerName, onClose }: SafetyNumberModalProps) => {
  const [state, setState] = useState<ModalState>({ kind: "loading" });
  const [marking, setMarking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    e2eeService
      .safetyNumberFor(peerId)
      .then((result) => {
        if (cancelled) return;
        if (!result) {
          setState({ kind: "error" });
          return;
        }
        setState({ kind: "loaded", formatted: result.formatted, verified: result.verified });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState(isNoKeysError(err) ? { kind: "no-keys" } : { kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [peerId]);

  const handleMarkVerified = async () => {
    setMarking(true);
    try {
      await e2eeService.markVerified(peerId);
      setState((prev) => (prev.kind === "loaded" ? { ...prev, verified: true } : prev));
      makeToast("success", `${peerName} marked as verified`);
    } catch {
      makeToast("error", "Failed to save verification");
    } finally {
      setMarking(false);
    }
  };

  const groups = state.kind === "loaded" ? state.formatted.split(" ") : [];

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 p-5 border-b border-gray-700">
            <div className="p-2 bg-primary-500/20 rounded-xl">
              <ShieldCheckIcon className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Safety Number</h3>
              <p className="text-xs text-gray-500">with {peerName}</p>
            </div>
            <button
              onClick={onClose}
              className="ml-auto p-1 text-gray-500 hover:text-white transition-colors"
              aria-label="Close"
            >
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5">
            {state.kind === "loading" ? (
              <div className="flex justify-center py-8">
                <div className="w-8 h-8 border-4 border-primary-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : state.kind === "no-keys" ? (
              <p className="text-sm text-gray-400">
                {peerName} hasn't enabled end-to-end encryption yet, so there is no safety number
                to compare. Once they enable encryption, you can verify them here.
              </p>
            ) : state.kind === "error" ? (
              <p className="text-sm text-gray-400">
                Couldn't compute the safety number right now. Make sure encryption is set up on
                this device and try again.
              </p>
            ) : (
              <>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Safety number</p>
                  {state.verified ? (
                    <span className="flex items-center gap-1 text-[11px] font-medium text-green-400 bg-green-500/10 border border-green-500/30 rounded-full px-2 py-0.5">
                      <CheckBadgeIcon className="w-3.5 h-3.5" /> Verified
                    </span>
                  ) : (
                    <span className="text-[11px] font-medium text-gray-400 bg-gray-700/50 border border-gray-600 rounded-full px-2 py-0.5">
                      Not verified
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-x-3 gap-y-2 bg-gray-900/70 border border-gray-700 rounded-xl p-4 mb-4">
                  {groups.map((group, i) => (
                    <span key={i} className="font-mono text-sm text-primary-300 text-center tracking-wider">
                      {group}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mb-4">
                  Compare these numbers with {peerName} over another channel (in person, a call, or
                  another messenger). If they match, your conversation is not being intercepted —
                  not even by the server.
                </p>
                {!state.verified && (
                  <button
                    onClick={handleMarkVerified}
                    disabled={marking}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                  >
                    {marking ? (
                      <>
                        <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                        Saving…
                      </>
                    ) : (
                      <>
                        <CheckBadgeIcon className="w-4 h-4" /> Mark as verified
                      </>
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default SafetyNumberModal;
