import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { LanguageIcon } from "@heroicons/react/24/outline";

const LANGS = [
  { code: "hi", label: "Hindi" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
];

// Uses MyMemory free API — no key required for basic usage
const translateText = async (text, targetLang) => {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLang}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.responseStatus === 200) return data.responseData.translatedText;
  throw new Error("Translation failed");
};

const TranslateButton = ({ text, messageId }) => {
  const [open, setOpen] = useState(false);
  const [translated, setTranslated] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeLang, setActiveLang] = useState(null);

  const handleTranslate = async (lang) => {
    if (activeLang === lang.code && translated) { setTranslated(null); setActiveLang(null); return; }
    setLoading(true);
    try {
      const result = await translateText(text, lang.code);
      setTranslated(result);
      setActiveLang(lang.code);
    } catch {
      setTranslated("Translation unavailable");
    } finally {
      setLoading(false);
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={() => { if (translated) { setTranslated(null); setActiveLang(null); } else setOpen((v) => !v); }}
        title="Translate"
        className={`p-1 rounded hover:bg-white/10 transition-colors ${activeLang ? "text-blue-300" : "text-white/50 hover:text-white/80"}`}
      >
        <LanguageIcon className="w-3.5 h-3.5" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="absolute bottom-6 right-0 w-44 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden"
          >
            {LANGS.map((lang) => (
              <button
                key={lang.code}
                onClick={() => handleTranslate(lang)}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700 transition-colors"
              >
                {lang.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {(loading || translated) && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1.5 text-xs italic opacity-75 leading-relaxed border-l-2 border-blue-400/40 pl-2"
          >
            {loading ? "Translating…" : translated}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default TranslateButton;
