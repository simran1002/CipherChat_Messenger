import React from "react";
import { motion, AnimatePresence } from "framer-motion";

const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

const ReactionPicker = ({ onSelect, visible }) => (
  <AnimatePresence>
    {visible && (
      <motion.div
        initial={{ opacity: 0, scale: 0.8, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.8, y: 4 }}
        transition={{ duration: 0.15 }}
        className="absolute -top-10 left-0 flex gap-1 bg-gray-800 border border-gray-700 rounded-full px-2 py-1 shadow-xl z-50"
      >
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            onClick={() => onSelect(emoji)}
            className="text-lg hover:scale-125 transition-transform leading-none"
            title={emoji}
          >
            {emoji}
          </button>
        ))}
      </motion.div>
    )}
  </AnimatePresence>
);

export default ReactionPicker;
