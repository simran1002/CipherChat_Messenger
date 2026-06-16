import React, { useState, useRef } from "react";
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { motion, AnimatePresence } from "framer-motion";

const MessageSearchBar = ({ onSearch, onClose }) => {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  const handleClear = () => {
    setQuery("");
    onSearch("");
    inputRef.current?.focus();
  };

  return (
    <motion.form
      initial={{ opacity: 0, width: 0 }}
      animate={{ opacity: 1, width: "auto" }}
      exit={{ opacity: 0, width: 0 }}
      onSubmit={handleSubmit}
      className="flex items-center gap-2 bg-gray-700 rounded-xl px-3 py-1.5"
    >
      <MagnifyingGlassIcon className="w-4 h-4 text-gray-400 shrink-0" />
      <input
        ref={inputRef}
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search messages…"
        className="bg-transparent text-sm text-gray-200 placeholder-gray-500 outline-none w-40 sm:w-56"
      />
      {query && (
        <button type="button" onClick={handleClear}>
          <XMarkIcon className="w-4 h-4 text-gray-400 hover:text-white" />
        </button>
      )}
      <button type="button" onClick={onClose}>
        <XMarkIcon className="w-4 h-4 text-gray-500 hover:text-red-400 ml-1" />
      </button>
    </motion.form>
  );
};

export default MessageSearchBar;
