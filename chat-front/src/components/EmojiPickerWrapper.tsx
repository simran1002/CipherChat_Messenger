import { useRef, useEffect, useState, type ComponentType } from "react";

/** Subset of the emoji-mart select payload this wrapper uses. */
interface EmojiMartEmoji {
  native: string;
}

interface EmojiPickerWrapperProps {
  onSelect: (native: string) => void;
  onClose: () => void;
}

interface PickerModule {
  Picker: ComponentType<Record<string, unknown>>;
  data: Record<string, unknown>;
}

/**
 * emoji-mart's dataset is ~400KB of the chatroom bundle — the single largest
 * dependency — and most sessions never open the picker. Both the component
 * and the data load on first open (this component only mounts then), landing
 * in their own async chunk; a skeleton box holds the space meanwhile.
 */
let cached: PickerModule | null = null;

const EmojiPickerWrapper = ({ onSelect, onClose }: EmojiPickerWrapperProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const [mod, setMod] = useState<PickerModule | null>(cached);

  useEffect(() => {
    if (cached) return;
    let alive = true;
    Promise.all([import("@emoji-mart/react"), import("@emoji-mart/data")]).then(
      ([picker, data]) => {
        cached = { Picker: picker.default, data: data.default };
        if (alive) setMod(cached);
      }
    );
    return () => {
      alive = false;
    };
  }, []);

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
      {mod ? (
        <mod.Picker
          data={mod.data}
          onEmojiSelect={(emoji: EmojiMartEmoji) => { onSelect(emoji.native); onClose(); }}
          theme="dark"
          previewPosition="none"
          skinTonePosition="none"
          perLine={8}
        />
      ) : (
        <div className="w-[352px] h-[420px] bg-gray-900 border border-gray-700/50 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-violet-400 border-t-transparent rounded-full animate-spin" />
        </div>
      )}
    </div>
  );
};

export default EmojiPickerWrapper;
