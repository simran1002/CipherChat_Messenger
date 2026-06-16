import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ClockIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { FireIcon } from "@heroicons/react/24/solid";

const OPTIONS = [
  { label: "30 seconds", value: 30 },
  { label: "5 minutes",  value: 300 },
  { label: "1 hour",     value: 3600 },
  { label: "24 hours",   value: 86400 },
  { label: "Never",      value: null },
];

const SelfDestructPicker = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const current = OPTIONS.find((o) => o.value === value) || OPTIONS[OPTIONS.length - 1];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Self-destruct timer"
        className={`p-2 rounded-xl transition-colors ${value ? "text-orange-400 bg-orange-500/10 hover:bg-orange-500/20" : "text-gray-400 hover:bg-gray-700 hover:text-orange-400"}`}
      >
        {value ? <FireIcon className="w-5 h-5" /> : <ClockIcon className="w-5 h-5" />}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.95 }}
            className="absolute bottom-12 left-0 w-52 bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl z-50 overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700">
              <span className="text-xs font-semibold text-gray-300 flex items-center gap-1.5">
                <FireIcon className="w-3.5 h-3.5 text-orange-400" /> Self-Destruct
              </span>
              <button onClick={() => setOpen(false)}><XMarkIcon className="w-4 h-4 text-gray-500" /></button>
            </div>
            <div className="py-1">
              {OPTIONS.map((opt) => (
                <button
                  key={String(opt.value)}
                  onClick={() => { onChange(opt.value); setOpen(false); }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-gray-700 transition-colors ${current.value === opt.value ? "text-orange-400" : "text-gray-300"}`}
                >
                  <span>{opt.label}</span>
                  {current.value === opt.value && <span className="text-orange-400">✓</span>}
                </button>
              ))}
            </div>
            {value && (
              <p className="text-[10px] text-orange-400/70 text-center pb-2 px-3">
                🔥 Messages will auto-delete after {current.label}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default SelfDestructPicker;
