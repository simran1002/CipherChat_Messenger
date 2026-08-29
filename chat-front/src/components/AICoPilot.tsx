import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  SparklesIcon,
  XMarkIcon,
  DocumentTextIcon,
  ChatBubbleLeftEllipsisIcon,
} from "@heroicons/react/24/outline";
import api from "../services/api";
import { makeToast } from "../utils/toast";

interface AICoPilotProps {
  chatroomId: string | undefined;
  onSelectSuggestion: (suggestion: string) => void;
  isOpen: boolean;
  onClose: () => void;
}

const AICoPilot = ({ chatroomId, onSelectSuggestion, isOpen, onClose }: AICoPilotProps) => {
  const [summary, setSummary] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);

  const getSummary = async () => {
    setLoadingSummary(true);
    setSummary("");
    try {
      const res = await api.post(`/ai/${chatroomId}/summarize`, { limit: 50 });
      setSummary(res.data.summary);
    } catch (err) {
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        "AI summarization unavailable";
      setSummary(`⚠️ ${msg.includes("ANTHROPIC_API_KEY") ? "Add your ANTHROPIC_API_KEY to chat-back/.env to enable AI features." : msg}`);
      makeToast("error", "AI unavailable");
    } finally {
      setLoadingSummary(false);
    }
  };

  const getSuggestions = async () => {
    setLoadingSuggestions(true);
    setSuggestions([]);
    try {
      const res = await api.post(`/ai/${chatroomId}/suggest-reply`);
      setSuggestions(res.data.suggestions);
    } catch (err) {
      // Surface the server's reason (e.g. AI not configured) instead of a generic toast
      const msg =
        (err as { response?: { data?: { message?: string } } })?.response?.data?.message ||
        "Could not generate suggestions";
      makeToast(
        "error",
        msg.includes("ANTHROPIC_API_KEY")
          ? "AI features need ANTHROPIC_API_KEY in chat-back/.env"
          : msg
      );
    } finally {
      setLoadingSuggestions(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          className="fixed right-4 bottom-24 w-80 bg-gray-800 border border-violet-500/30 rounded-2xl shadow-2xl z-50 overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-r from-violet-900/50 to-purple-900/50 border-b border-gray-700">
            <div className="flex items-center gap-2">
              <SparklesIcon className="w-4 h-4 text-violet-400" />
              <span className="text-sm font-semibold text-white">AI Co-Pilot</span>
            </div>
            <button onClick={onClose} className="p-1 hover:bg-gray-700 rounded-lg">
              <XMarkIcon className="w-4 h-4 text-gray-400" />
            </button>
          </div>

          <div className="p-4 space-y-4">
            {/* Summarize */}
            <div>
              <button
                onClick={getSummary}
                disabled={loadingSummary}
                className="w-full flex items-center gap-2 px-3 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-200 transition-colors disabled:opacity-60"
              >
                {loadingSummary ? (
                  <div className="w-4 h-4 border-2 border-violet-400/40 border-t-violet-400 rounded-full animate-spin" />
                ) : (
                  <DocumentTextIcon className="w-4 h-4 text-violet-400" />
                )}
                {loadingSummary ? "Summarizing…" : "Summarize this conversation"}
              </button>
              {summary && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  className="mt-2 p-3 bg-gray-700/60 rounded-xl text-xs text-gray-300 leading-relaxed whitespace-pre-line border border-gray-600"
                >
                  {summary}
                </motion.div>
              )}
            </div>

            {/* Reply suggestions */}
            <div>
              <button
                onClick={getSuggestions}
                disabled={loadingSuggestions}
                className="w-full flex items-center gap-2 px-3 py-2.5 bg-gray-700 hover:bg-gray-600 rounded-xl text-sm text-gray-200 transition-colors disabled:opacity-60"
              >
                {loadingSuggestions ? (
                  <div className="w-4 h-4 border-2 border-violet-400/40 border-t-violet-400 rounded-full animate-spin" />
                ) : (
                  <ChatBubbleLeftEllipsisIcon className="w-4 h-4 text-violet-400" />
                )}
                {loadingSuggestions ? "Thinking…" : "Suggest replies"}
              </button>
              <AnimatePresence>
                {suggestions.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="mt-2 flex flex-col gap-2"
                  >
                    {suggestions.map((s, i) => (
                      <button
                        key={i}
                        onClick={() => { onSelectSuggestion(s); onClose(); }}
                        className="text-left px-3 py-2 bg-violet-900/30 hover:bg-violet-900/50 border border-violet-600/30 rounded-xl text-xs text-gray-200 transition-colors"
                      >
                        💬 {s}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <p className="text-[10px] text-gray-600 text-center">Powered by Claude Haiku</p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AICoPilot;
