import React, { useState } from 'react';
import { 
  TrashIcon, 
  ExclamationTriangleIcon,
  XMarkIcon 
} from '@heroicons/react/24/outline';

const MessageDelete = ({ 
  message, 
  onDelete, 
  onCancel, 
  isDeleting = false 
}) => {
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleDeleteClick = () => {
    setShowConfirmation(true);
  };

  const handleConfirmDelete = async () => {
    setIsProcessing(true);
    try {
      await onDelete(message._id);
      setShowConfirmation(false);
    } catch (error) {
      console.error('Error deleting message:', error);
      alert('Failed to delete message. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCancelDelete = () => {
    setShowConfirmation(false);
    onCancel();
  };

  if (showConfirmation) {
    return (
      <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl w-full max-w-md">
          {/* Header */}
          <div className="flex items-center space-x-3 p-6 border-b border-gray-200 dark:border-gray-700">
            <div className="p-2 bg-red-100 dark:bg-red-900 rounded-lg">
              <ExclamationTriangleIcon className="w-6 h-6 text-red-600 dark:text-red-400" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-gray-100">
                Delete Message
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                This action cannot be undone
              </p>
            </div>
          </div>

          {/* Content */}
          <div className="p-6">
            <p className="text-gray-700 dark:text-gray-300 mb-4">
              Are you sure you want to delete this message? This action cannot be undone.
            </p>
            
            {/* Message Preview */}
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 mb-4">
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-1">
                Message preview:
              </p>
              <p className="text-gray-900 dark:text-gray-100 text-sm">
                {message.content?.length > 100 
                  ? `${message.content.substring(0, 100)}...` 
                  : message.content
                }
              </p>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end space-x-3 p-6 border-t border-gray-200 dark:border-gray-700">
            <button
              onClick={handleCancelDelete}
              disabled={isProcessing}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmDelete}
              disabled={isProcessing}
              className="px-6 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white text-sm font-medium rounded-lg transition-colors duration-200 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              {isProcessing ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Deleting...</span>
                </>
              ) : (
                <>
                  <TrashIcon className="w-4 h-4" />
                  <span>Delete</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={handleDeleteClick}
      disabled={isDeleting}
      className="p-1 rounded-full hover:bg-red-100 dark:hover:bg-red-900 transition-colors duration-200 opacity-0 group-hover:opacity-100 disabled:opacity-50"
      title="Delete message"
    >
      <TrashIcon className="w-3 h-3 text-red-500" />
    </button>
  );
};

export default MessageDelete; 