import { motion, AnimatePresence } from "framer-motion";
import { ChevronDownIcon } from "@heroicons/react/24/solid";

interface ScrollToBottomFABProps {
  visible: boolean;
  unread: number;
  onClick: () => void;
}

const ScrollToBottomFAB = ({ visible, unread, onClick }: ScrollToBottomFABProps) => (
  <AnimatePresence>
    {visible && (
      <motion.button
        initial={{ opacity: 0, scale: 0.8 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.8 }}
        onClick={onClick}
        className="absolute bottom-4 right-4 z-20 flex items-center justify-center w-10 h-10 bg-violet-600 hover:bg-violet-500 text-white rounded-full shadow-lg transition-colors"
        aria-label="Scroll to bottom"
      >
        {unread > 0 && (
          <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
        <ChevronDownIcon className="w-5 h-5" />
      </motion.button>
    )}
  </AnimatePresence>
);

export default ScrollToBottomFAB;
