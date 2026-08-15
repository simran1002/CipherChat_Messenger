import { useRef, useEffect } from "react";
import data from "@emoji-mart/data";
import Picker from "@emoji-mart/react";

/** Subset of the emoji-mart select payload this wrapper uses. */
interface EmojiMartEmoji {
  native: string;
}

interface EmojiPickerWrapperProps {
  onSelect: (native: string) => void;
  onClose: () => void;
}

const EmojiPickerWrapper = ({ onSelect, onClose }: EmojiPickerWrapperProps) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
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
        onEmojiSelect={(emoji: EmojiMartEmoji) => { onSelect(emoji.native); onClose(); }}
        theme="dark"
        previewPosition="none"
        skinTonePosition="none"
        perLine={8}
      />
    </div>
  );
};

export default EmojiPickerWrapper;
