import React, { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PaperAirplaneIcon,
  MicrophoneIcon,
  FaceSmileIcon,
  PaperClipIcon,
  MapPinIcon,
  XMarkIcon,
  ArrowUturnLeftIcon,
  ShieldExclamationIcon,
  SparklesIcon,
} from "@heroicons/react/24/outline";
import EmojiPickerWrapper from "./EmojiPickerWrapper";
import VoiceRecorder from "./VoiceRecorder";
import SelfDestructPicker from "./SelfDestructPicker";
import { detectSensitiveData } from "./SensitiveDataDetector";
import api from "../services/api";
import makeToast from "../Toaster";

// Tone labels + colors
const TONE_CONFIG = {
  neutral:    { label: null,          color: null },
  positive:   { label: "😊 Positive",  color: "text-green-400" },
  excited:    { label: "🎉 Excited",   color: "text-yellow-400" },
  frustrated: { label: "😤 Frustrated", color: "text-orange-400" },
  harsh:      { label: "⚡ Harsh",     color: "text-red-400" },
  sad:        { label: "😢 Sad",       color: "text-blue-400" },
};

const MessageInput = ({
  value,
  onChange,
  onSubmit,
  onTyping,
  onSendFile,
  onSendVoice,
  onSendLocation,
  onOpenAI,
  disabled,
  inputRef,
  replyTo,
  onCancelReply,
  expiresIn,
  onExpiresInChange,
}) => {
  const [showEmoji, setShowEmoji] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sensitiveWarning, setSensitiveWarning] = useState(null);
  const [toneInfo, setToneInfo] = useState(null);
  const [toneOverride, setToneOverride] = useState(null); // user accepted the suggestion
  const fileInputRef = useRef(null);
  const toneTimerRef = useRef(null);

  // Debounced tone + sensitive check
  useEffect(() => {
    if (!value.trim()) { setSensitiveWarning(null); setToneInfo(null); return; }

    // Sensitive data detection (instant, client-side)
    const sensitive = detectSensitiveData(value);
    setSensitiveWarning(sensitive);

    // Tone detection after pause (calls backend AI — only if key configured)
    clearTimeout(toneTimerRef.current);
    if (value.trim().length > 15) {
      toneTimerRef.current = setTimeout(async () => {
        try {
          const res = await api.post("/ai/tone", { message: value.trim() });
          if (res.data.tone && res.data.tone !== "neutral") setToneInfo(res.data);
          else setToneInfo(null);
        } catch {
          // Silently ignore if AI not configured
        }
      }, 1500);
    } else {
      setToneInfo(null);
    }

    return () => clearTimeout(toneTimerRef.current);
  }, [value]);

  const handleEmojiSelect = (emoji) => {
    const fakeEvent = { target: { value: value + emoji } };
    onChange(fakeEvent);
    inputRef?.current?.focus();
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await api.post("/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      const { url, fileName, mimeType, fileSize } = res.data;
      let type = "file";
      if (mimeType.startsWith("image/")) type = "image";
      else if (mimeType.startsWith("audio/")) type = "audio";
      onSendFile({ fileUrl: url, fileName, mimeType, fileSize, type });
    } catch {
      makeToast("error", "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const handleVoiceSend = async (blob) => {
    setShowVoice(false);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", blob, "voice-message.webm");
      const res = await api.post("/upload", fd, { headers: { "Content-Type": "multipart/form-data" } });
      const { url, fileSize } = res.data;
      onSendVoice({ fileUrl: url, fileName: "Voice message", mimeType: "audio/webm", fileSize, type: "audio" });
    } catch {
      makeToast("error", "Failed to send voice message");
    } finally {
      setUploading(false);
    }
  };

  const handleLocation = () => {
    if (!navigator.geolocation) return makeToast("error", "Geolocation not supported");
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => onSendLocation({ lat: coords.latitude, lng: coords.longitude }),
      () => makeToast("error", "Location access denied")
    );
  };

  const handleSubmit = (e) => {
    if (toneOverride) {
      // User chose the AI-suggested softened version
      const fakeEvent = { target: { value: toneOverride } };
      onChange(fakeEvent);
      setToneOverride(null);
      setToneInfo(null);
      setTimeout(() => onSubmit(e), 50);
    } else {
      onSubmit(e);
    }
  };

  const hasText = value.trim().length > 0;
  const tone = toneInfo ? (TONE_CONFIG[toneInfo.tone] || TONE_CONFIG.neutral) : null;

  if (showVoice) {
    return (
      <div className="px-4 py-3 border-t border-gray-700/50 bg-gray-900/90 backdrop-blur-sm">
        <VoiceRecorder onSend={handleVoiceSend} onCancel={() => setShowVoice(false)} />
      </div>
    );
  }

  return (
    <div className="border-t border-gray-700/50 bg-gray-900/90 backdrop-blur-sm shrink-0">
      {/* Sensitive data warning */}
      <AnimatePresence>
        {sensitiveWarning && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-start gap-2 px-4 pt-2 pb-0"
          >
            <ShieldExclamationIcon className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <span className="text-xs font-semibold text-red-400">{sensitiveWarning.type} detected — </span>
              <span className="text-xs text-gray-400">{sensitiveWarning.suggestion}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tone hint */}
      <AnimatePresence>
        {toneInfo && tone?.label && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-center gap-2 px-4 pt-2 pb-0"
          >
            <span className={`text-xs font-medium ${tone.color}`}>{tone.label}</span>
            {toneInfo.suggestion && (
              <>
                <span className="text-xs text-gray-500">→</span>
                <button
                  onClick={() => { onChange({ target: { value: toneInfo.suggestion } }); setToneInfo(null); }}
                  className="text-xs text-violet-400 hover:text-violet-300 underline underline-offset-2"
                >
                  Use softer version
                </button>
              </>
            )}
            <button onClick={() => setToneInfo(null)} className="ml-auto">
              <XMarkIcon className="w-3.5 h-3.5 text-gray-600 hover:text-gray-400" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Reply preview */}
      <AnimatePresence>
        {replyTo && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex items-center gap-2 px-4 pt-2 pb-0"
          >
            <ArrowUturnLeftIcon className="w-3.5 h-3.5 text-violet-400 shrink-0" />
            <div className="flex-1 border-l-2 border-violet-400 pl-2 min-w-0">
              <span className="text-xs text-violet-400 font-medium">{replyTo.senderName}</span>
              <p className="text-xs text-gray-400 truncate">{replyTo.preview}</p>
            </div>
            <button onClick={onCancelReply} className="p-1 hover:bg-gray-700 rounded">
              <XMarkIcon className="w-4 h-4 text-gray-400" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="relative px-3 py-3 flex items-end gap-2">
        {showEmoji && (
          <EmojiPickerWrapper onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} />
        )}

        {/* Left toolbar */}
        <div className="flex items-center gap-0.5 shrink-0">
          <button type="button" onClick={() => setShowEmoji((v) => !v)} disabled={disabled}
            className="p-2 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-yellow-400 transition-colors disabled:opacity-40" title="Emoji">
            <FaceSmileIcon className="w-5 h-5" />
          </button>
          <button type="button" onClick={() => fileInputRef.current?.click()} disabled={disabled || uploading}
            className="p-2 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-blue-400 transition-colors disabled:opacity-40" title="Attach file">
            <PaperClipIcon className="w-5 h-5" />
          </button>
          <button type="button" onClick={handleLocation} disabled={disabled}
            className="p-2 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-green-400 transition-colors disabled:opacity-40" title="Share location">
            <MapPinIcon className="w-5 h-5" />
          </button>
          <SelfDestructPicker value={expiresIn} onChange={onExpiresInChange} />
          {onOpenAI && (
            <button type="button" onClick={onOpenAI} disabled={disabled}
              className="p-2 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-violet-400 transition-colors disabled:opacity-40" title="AI Co-Pilot">
              <SparklesIcon className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Text input */}
        <textarea
          ref={inputRef}
          value={value}
          onChange={onChange}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e); }
          }}
          onInput={onTyping}
          disabled={disabled || uploading}
          placeholder={uploading ? "Uploading…" : "Type a message… (Enter to send)"}
          rows={1}
          aria-label="Message input"
          className="flex-1 bg-gray-700/60 border border-gray-600 focus:border-violet-500 focus:ring-1 focus:ring-violet-500/40 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-500 outline-none resize-none transition-all leading-relaxed max-h-32 overflow-y-auto"
        />

        {/* Send or mic */}
        {hasText ? (
          <motion.button whileTap={{ scale: 0.88 }} type="button" onClick={handleSubmit} disabled={disabled}
            className="p-2.5 bg-violet-600 hover:bg-violet-500 rounded-xl text-white transition-all disabled:opacity-40 shrink-0">
            <PaperAirplaneIcon className="w-5 h-5" />
          </motion.button>
        ) : (
          <motion.button whileTap={{ scale: 0.88 }} type="button" onClick={() => setShowVoice(true)} disabled={disabled}
            className="p-2.5 bg-gray-700 hover:bg-violet-600 rounded-xl text-gray-400 hover:text-white transition-all disabled:opacity-40 shrink-0">
            <MicrophoneIcon className="w-5 h-5" />
          </motion.button>
        )}

        <input ref={fileInputRef} type="file" accept="image/*,audio/*,.pdf,.doc,.docx,.txt" className="hidden" onChange={handleFileChange} />
      </div>

      {/* Self-destruct indicator */}
      {expiresIn && (
        <p className="text-[10px] text-orange-400/70 text-center pb-1.5">
          🔥 Next message self-destructs in {expiresIn < 60 ? `${expiresIn}s` : expiresIn < 3600 ? `${expiresIn / 60}m` : `${expiresIn / 3600}h`}
        </p>
      )}
    </div>
  );
};

export default MessageInput;
