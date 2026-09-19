/**
 * "What is actually protecting this conversation, right now" — the customer-facing translation of
 * ADR-0011's two protocols. Deliberately makes no claim the crypto doesn't back: v1's exposure is stated
 * as the whole current session (a stolen chain root re-derives any message key in it, not just ones
 * already sent), and v2's is stated as "until your next reply" (post-compromise recovery needs one more
 * DH turn from the honest party), not "immediately safe again".
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowPathRoundedSquareIcon,
  CheckCircleIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  ShieldExclamationIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import e2eeService, { type EncryptionStatus } from "../services/E2EEService";

interface EncryptionStatusModalProps {
  conversationId: string;
  peerName: string;
  onClose: () => void;
  /** So "Upgrade" can hand off to the same toggle the header button drives, instead of duplicating it. */
  onUpgrade?: () => void;
}

function daysUntil(epochMs: number): number {
  return Math.max(0, Math.ceil((epochMs - Date.now()) / (24 * 60 * 60 * 1000)));
}

const EncryptionStatusModal = ({ conversationId, peerName, onClose, onUpgrade }: EncryptionStatusModalProps) => {
  const [status, setStatus] = useState<EncryptionStatus | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    e2eeService
      .encryptionStatus(conversationId)
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

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
              <ShieldExclamationIcon className="w-5 h-5 text-primary-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Encryption Status</h3>
              <p className="text-xs text-gray-500">with {peerName}</p>
            </div>
            <button onClick={onClose} className="ml-auto p-1 text-gray-500 hover:text-white transition-colors" aria-label="Close">
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5">
            {error ? (
              <p className="text-sm text-gray-400">Couldn't read this conversation's encryption state right now.</p>
            ) : !status ? (
              <div className="flex justify-center py-8">
                <div className="w-8 h-8 border-4 border-primary-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : status.protocol === "none" ? (
              <p className="text-sm text-gray-400">
                No session yet — this shows up as soon as the first message with {peerName} is sent or received.
              </p>
            ) : status.protocol === "v2" ? (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2.5 py-1">
                    <ArrowPathRoundedSquareIcon className="w-3.5 h-3.5" /> Double Ratchet
                  </span>
                  <span className="text-xs text-gray-500">per-message forward secrecy</span>
                </div>
                <ul className="space-y-3 text-sm">
                  <li className="flex gap-2.5">
                    <CheckCircleIcon className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <span className="text-gray-300">
                      Every message key is destroyed the instant it's used. If this device were compromised{" "}
                      <strong className="text-white">right now</strong>, none of the {status.messagesSent.toLocaleString()}{" "}
                      messages already exchanged on this session could be read — not by an attacker, and not
                      by you re-deriving them either.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <ExclamationTriangleIcon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-gray-300">
                      A compromise could still read what {peerName} sends <em>next</em>, until one more reply
                      passes between you — the ratchet heals the connection automatically, with nothing for
                      either of you to do.
                    </span>
                  </li>
                </ul>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <span
                    className={`flex items-center gap-1.5 text-xs font-semibold rounded-full px-2.5 py-1 border ${
                      status.needsRotation
                        ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
                        : "text-gray-300 bg-gray-700/50 border-gray-600"
                    }`}
                  >
                    <ClockIcon className="w-3.5 h-3.5" /> Session-protected (v1)
                  </span>
                </div>
                <ul className="space-y-3 text-sm mb-4">
                  <li className="flex gap-2.5">
                    <ExclamationTriangleIcon className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-gray-300">
                      Keys rotate as a session, not per message. If this device were compromised{" "}
                      <strong className="text-white">right now</strong>, every message in the{" "}
                      <strong className="text-white">current session</strong> could be re-derived from one
                      stolen key — earlier sessions cannot, because their keys already rotated away.
                    </span>
                  </li>
                  <li className="flex gap-2.5">
                    <CheckCircleIcon className="w-5 h-5 text-gray-500 shrink-0 mt-0.5" />
                    <span className="text-gray-300">
                      {status.needsRotation
                        ? "This session is due to rotate — the next message starts a fresh one automatically."
                        : `Rotates automatically in ${daysUntil(status.rotatesAt)} day${daysUntil(status.rotatesAt) === 1 ? "" : "s"}, or after ${status.messagesUntilRotation.toLocaleString()} more message${status.messagesUntilRotation === 1 ? "" : "s"}, whichever comes first.`}
                    </span>
                  </li>
                </ul>
                {onUpgrade && (
                  <button
                    onClick={onUpgrade}
                    className="w-full py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white text-sm font-medium flex items-center justify-center gap-2 transition-all"
                  >
                    <ArrowPathRoundedSquareIcon className="w-4 h-4" /> Start a Double Ratchet session
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

export default EncryptionStatusModal;
