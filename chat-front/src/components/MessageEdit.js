import React, { useState, useEffect, useRef } from 'react';
import { 
  CheckIcon, 
  XMarkIcon, 
  PencilIcon 
} from '@heroicons/react/24/outline';

const MessageEdit = ({ 
  message, 
  isEditing, 
  onSave, 
  onCancel, 
  onStartEdit 
}) => {
  const [editText, setEditText] = useState(message?.content || '');
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(
        textareaRef.current.value.length,
        textareaRef.current.value.length
      );
    }
  }, [isEditing]);

  const handleSave = async () => {
    if (!editText.trim() || editText === message.content) {
      onCancel();
      return;
    }

    setIsSaving(true);
    try {
      await onSave(editText.trim());
    } catch (error) {
      console.error('Error saving edited message:', error);
      alert('Failed to save changes. Please try again.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditText(message?.content || '');
    onCancel();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    } else if (e.key === 'Escape') {
      handleCancel();
    }
  };

  if (!isEditing) {
    return (
      <button
        onClick={onStartEdit}
        className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-200 opacity-0 group-hover:opacity-100"
        title="Edit message"
      >
        <PencilIcon className="w-3 h-3 text-gray-500 dark:text-gray-400" />
      </button>
    );
  }

  return (
    <div className="absolute top-0 left-0 right-0 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-3 z-10">
      <div className="space-y-3">
        {/* Edit Label */}
        <div className="flex items-center space-x-2">
          <PencilIcon className="w-4 h-4 text-blue-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Edit message
          </span>
        </div>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleKeyDown}
          className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 resize-none"
          rows={Math.min(4, Math.max(2, editText.split('\n').length))}
          placeholder="Edit your message..."
          maxLength={1000}
        />

        {/* Character Count */}
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {editText.length}/1000 characters
          </span>
          
          {/* Action Buttons */}
          <div className="flex items-center space-x-2">
            <button
              onClick={handleCancel}
              disabled={isSaving}
              className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-200 disabled:opacity-50"
              title="Cancel"
            >
              <XMarkIcon className="w-4 h-4 text-gray-500 dark:text-gray-400" />
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || !editText.trim() || editText === message.content}
              className="p-1 rounded-full hover:bg-green-100 dark:hover:bg-green-900 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
              title="Save changes"
            >
              <CheckIcon className="w-4 h-4 text-green-500" />
            </button>
          </div>
        </div>

        {/* Saving Indicator */}
        {isSaving && (
          <div className="flex items-center space-x-2 text-sm text-gray-500 dark:text-gray-400">
            <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            <span>Saving...</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default MessageEdit; 