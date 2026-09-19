/**
 * Search across EVERY direct-message conversation this device has decrypted, in one box — ranked and
 * typo-tolerant, entirely on-device. The server never sees the query: `searchMessages` with no `convId`
 * queries the same on-device Orama index each conversation already indexes into (search/searchCore.ts),
 * just without the conversation filter.
 *
 * Coverage is exactly what this device has opened and decrypted before — a conversation never opened
 * here has nothing in the index, which the empty state below says outright rather than implying an
 * empty result means "no matches anywhere".
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { searchMessages } from "../search/searchClient";
import { formatTime } from "../utils/helpers";
import type { DmConversation } from "../types";

interface GlobalSearchModalProps {
  conversations: DmConversation[];
  onClose: () => void;
  onJump: (conversation: DmConversation) => void;
}

interface ResultRow {
  id: string;
  convId: string;
  text: string;
  ts: number;
  peerName: string;
  peerDp?: string;
}

const GlobalSearchModal = ({ conversations, onClose, onJump }: GlobalSearchModalProps) => {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<ResultRow[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = term.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchMessages(q, { limit: 40 }).then((hits) => {
        if (cancelled) return;
        const byConv = new Map(conversations.map((c) => [c._id, c]));
        setResults(
          hits.map((h) => {
            const conv = byConv.get(h.convId);
            return {
              id: h.id,
              convId: h.convId,
              text: h.text,
              ts: h.ts,
              peerName: conv?.participant?.name ?? "Unknown conversation",
              peerDp: conv?.participant?.dp,
            };
          })
        );
        setSearching(false);
      });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, conversations]);

  const jump = (row: ResultRow) => {
    const conv = conversations.find((c) => c._id === row.convId);
    if (!conv) return;
    onJump(conv);
    onClose();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[10vh] p-4 z-50"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0, y: -10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.95, opacity: 0, y: -10 }}
          className="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-lg shadow-2xl max-h-[70vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-2 p-4 border-b border-gray-700 shrink-0">
            <MagnifyingGlassIcon className="w-5 h-5 text-gray-500 shrink-0" />
            <input
              autoFocus
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search all your conversations…"
              aria-label="Search all direct messages"
              className="flex-1 bg-transparent text-white placeholder-gray-500 focus:outline-none text-sm"
            />
            <button onClick={onClose} className="p-1 text-gray-500 hover:text-white transition-colors" aria-label="Close">
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="overflow-y-auto flex-1">
            {term.trim().length < 2 ? (
              <p className="text-sm text-gray-500 p-6 text-center">
                Type at least 2 characters. This only finds messages already decrypted on this
                device — the server never sees what you type here, and never could.
              </p>
            ) : searching && results === null ? (
              <div className="flex justify-center py-10">
                <div className="w-6 h-6 border-4 border-primary-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !results || results.length === 0 ? (
              <p className="text-sm text-gray-500 p-6 text-center">
                No matches on this device. Conversations you haven't opened here yet aren't indexed —
                open one to search inside it.
              </p>
            ) : (
              <ul>
                {results.map((row) => (
                  <li key={row.id}>
                    <button
                      onClick={() => jump(row)}
                      className="w-full text-left px-4 py-3 hover:bg-gray-700/50 transition-colors border-b border-gray-700/40 flex items-start gap-3"
                    >
                      <div className="w-8 h-8 rounded-full bg-primary-500/20 text-primary-300 flex items-center justify-center text-xs font-semibold shrink-0 overflow-hidden">
                        {row.peerDp ? (
                          <img src={row.peerDp} alt="" className="w-full h-full object-cover" />
                        ) : (
                          row.peerName.slice(0, 2).toUpperCase()
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-white truncate">{row.peerName}</p>
                          <span className="text-[11px] text-gray-500 shrink-0">{formatTime(row.ts)}</span>
                        </div>
                        <p className="text-xs text-gray-400 truncate mt-0.5">{row.text}</p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default GlobalSearchModal;
