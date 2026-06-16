import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { TrashIcon, ExclamationTriangleIcon, XMarkIcon } from "@heroicons/react/24/outline";

/**
 * Props:
 *   messageId       – the message _id
 *   messagePreview  – first ~80 chars of the message for preview
 *   onDelete(messageId) – async callback; parent calls API + updates state
 *   onCancel()          – dismiss without deleting
 */
const MessageDelete = ({ messageId, messagePreview, onDelete, onCancel }) => {
  const [processing, setProcessing] = useState(false);

  const handleConfirm = async () => {
    setProcessing(true);
    await onDelete(messageId);
    setProcessing(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
        onClick={onCancel}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          className="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-sm shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-3 p-5 border-b border-gray-700">
            <div className="p-2 bg-red-500/20 rounded-xl">
              <ExclamationTriangleIcon className="w-5 h-5 text-red-400" />
            </div>
            <div>
              <h3 className="font-semibold text-white">Delete Message</h3>
              <p className="text-xs text-gray-500">This cannot be undone</p>
            </div>
            <button onClick={onCancel} className="ml-auto p-1 text-gray-500 hover:text-white transition-colors">
              <XMarkIcon className="w-4 h-4" />
            </button>
          </div>

          <div className="p-5">
            <p className="text-sm text-gray-400 mb-3">Are you sure you want to delete this message?</p>
            {messagePreview && (
              <div className="bg-gray-700/50 border border-gray-700 rounded-xl p-3 text-sm text-gray-400 italic line-clamp-2">
                "{messagePreview}"
              </div>
            )}
          </div>

          <div className="flex gap-3 px-5 pb-5">
            <button
              onClick={onCancel}
              disabled={processing}
              className="flex-1 py-2 rounded-xl border border-gray-600 text-gray-300 hover:text-white hover:border-gray-500 text-sm font-medium transition-all"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={processing}
              className="flex-1 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
            >
              {processing ? (
                <><div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> Deleting…</>
              ) : (
                <><TrashIcon className="w-3.5 h-3.5" /> Delete</>
              )}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default MessageDelete;
