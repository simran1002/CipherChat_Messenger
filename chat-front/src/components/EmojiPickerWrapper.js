import React, { useRef, useEffect } from "react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";

const EmojiPickerWrapper = ({ onSelect, onClose }) => {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute bottom-16 left-0 z-50 shadow-2xl rounded-2xl overflow-hidden"
    >
      <Picker
        data={data}
        onEmojiSelect={(emoji) => { onSelect(emoji.native); onClose(); }}
        theme="dark"
        previewPosition="none"
        skinTonePosition="none"
        perLine={8}
      />
    </div>
  );
};

export default EmojiPickerWrapper;
