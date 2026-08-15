import { useState } from "react";
import { motion } from "framer-motion";
import { CheckIcon, XMarkIcon } from "@heroicons/react/24/outline";

const MAX_LEN = 2000;

interface MessageEditProps {
  /** The message _id. */
  messageId: string;
  /** Current message text. */
  initialText: string;
  /** Async callback; parent calls API + updates state. */
  onSave: (messageId: string, newText: string) => void | Promise<void>;
  /** Closes the editor without saving. */
  onCancel: () => void;
}

const MessageEdit = ({ messageId, initialText, onSave, onCancel }: MessageEditProps) => {
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!text.trim() || text.trim() === initialText.trim()) {
      onCancel();
      return;
    }
    setSaving(true);
    await onSave(messageId, text.trim());
    setSaving(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex flex-col gap-2 w-full"
    >
      <textarea
        className="w-full bg-gray-700 border border-primary-500 text-white rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_LEN}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSave(); }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-gray-500">{text.length}/{MAX_LEN}</span>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
          >
            <XMarkIcon className="w-3.5 h-3.5" /> Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !text.trim()}
            className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs bg-primary-600 hover:bg-primary-700 text-white disabled:opacity-40 transition-colors"
          >
            <CheckIcon className="w-3.5 h-3.5" />
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </motion.div>
  );
};

export default MessageEdit;
