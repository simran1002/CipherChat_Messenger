import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../services/api";
import { makeToast } from "../utils/toast";
import type { AppSocket } from "../types";

export interface PresenceOption {
  value: string;
  label: string;
  emoji: string;
  color: string;
}

export const PRESENCE_OPTIONS: PresenceOption[] = [
  { value: "available",  label: "Available",   emoji: "🟢", color: "text-green-400" },
  { value: "coding",     label: "Coding",      emoji: "💻", color: "text-blue-400" },
  { value: "in_meeting", label: "In Meeting",  emoji: "📅", color: "text-yellow-400" },
  { value: "focusing",   label: "Focusing",    emoji: "🎯", color: "text-orange-400" },
  { value: "driving",    label: "Driving",     emoji: "🚗", color: "text-purple-400" },
  { value: "away",       label: "Away",        emoji: "🌙", color: "text-gray-400" },
  { value: "busy",       label: "Busy",        emoji: "🔴", color: "text-red-400" },
];

export const getPresence = (value: string | null | undefined): PresenceOption =>
  PRESENCE_OPTIONS.find((o) => o.value === value) || PRESENCE_OPTIONS[0]!;

export interface PresenceUpdate {
  presenceStatus: string;
  presenceNote: string;
}

interface PresencePickerProps {
  currentStatus?: string;
  currentNote?: string;
  onUpdate?: (update: PresenceUpdate) => void;
  socket?: AppSocket | null;
}

const PresencePicker = ({ currentStatus = "available", currentNote = "", onUpdate, socket }: PresencePickerProps) => {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState(currentNote);
  const current = getPresence(currentStatus);

  const handleSelect = async (option: PresenceOption) => {
    try {
      await api.put("/presence", { presenceStatus: option.value, presenceNote: note });
      socket?.emit("presenceUpdate", { presenceStatus: option.value, presenceNote: note });
      onUpdate?.({ presenceStatus: option.value, presenceNote: note });
      setOpen(false);
    } catch {
      makeToast("error", "Failed to update status");
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-gray-700/50 transition-colors text-xs"
        title="Set your status"
      >
        <span>{current.emoji}</span>
        <span className={`font-medium ${current.color}`}>{current.label}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            className="absolute bottom-8 left-0 w-60 bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl z-50 overflow-hidden"
          >
            <div className="p-3 border-b border-gray-700">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="What are you up to? (optional)"
                maxLength={80}
                className="w-full bg-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-500 outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>
            <div className="py-1">
              {PRESENCE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => handleSelect(opt)}
                  className={`w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-gray-700 transition-colors ${currentStatus === opt.value ? "bg-gray-700/60" : ""}`}
                >
                  <span className="text-base">{opt.emoji}</span>
                  <span className={opt.color}>{opt.label}</span>
                  {currentStatus === opt.value && <span className="ml-auto text-violet-400 text-xs">✓</span>}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PresencePicker;
