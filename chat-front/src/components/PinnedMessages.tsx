import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { MapPinIcon, ChevronDownIcon, ChevronUpIcon } from "@heroicons/react/24/solid";
import { XMarkIcon } from "@heroicons/react/24/outline";

/**
 * Row shape returned by GET /chatroom/:id/pinned — unlike ChatMessage,
 * the sender comes back as a populated `user` object rather than flat
 * name/userId fields, so this stays a local type.
 */
export interface PinnedMessageItem {
  _id: string;
  message?: string | null;
  user?: { _id?: string; name?: string } | null;
}

interface PinnedMessagesProps {
  messages: PinnedMessageItem[] | null | undefined;
  onUnpin?: (messageId: string) => void;
}

const PinnedMessages = ({ messages, onUnpin }: PinnedMessagesProps) => {
  const [expanded, setExpanded] = useState(false);
  if (!messages || messages.length === 0) return null;

  const latest = messages[0]!;

  return (
    <div className="border-b border-gray-700/50 bg-gray-800/60 backdrop-blur-sm">
      <div
        className="flex items-center gap-2 px-4 py-2 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <MapPinIcon className="w-4 h-4 text-violet-400 shrink-0" />
        <span className="text-xs text-gray-400 shrink-0">
          {messages.length} pinned
        </span>
        <span className="text-sm text-gray-200 truncate flex-1">
          {latest.message?.slice(0, 60)}
        </span>
        {expanded ? (
          <ChevronUpIcon className="w-4 h-4 text-gray-400 shrink-0" />
        ) : (
          <ChevronDownIcon className="w-4 h-4 text-gray-400 shrink-0" />
        )}
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            {messages.map((msg) => (
              <div
                key={msg._id}
                className="flex items-center gap-2 px-4 py-1.5 border-t border-gray-700/30"
              >
                <span className="text-xs text-violet-400 shrink-0">
                  {msg.user?.name}:
                </span>
                <span className="text-sm text-gray-300 truncate flex-1">
                  {msg.message?.slice(0, 80)}
                </span>
                {onUnpin && (
                  <button
                    onClick={() => onUnpin(msg._id)}
                    className="p-1 hover:bg-gray-700 rounded"
                  >
                    <XMarkIcon className="w-3.5 h-3.5 text-gray-500 hover:text-red-400" />
                  </button>
                )}
              </div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PinnedMessages;
