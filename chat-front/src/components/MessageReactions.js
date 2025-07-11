import React, { useState } from 'react';
import { HeartIcon, HandThumbUpIcon, FaceSmileIcon } from '@heroicons/react/24/outline';
import { HeartIcon as HeartSolidIcon, HandThumbUpIcon as HandThumbUpSolidIcon } from '@heroicons/react/24/solid';

const MessageReactions = ({ messageId, reactions = {}, onReact, currentUserId }) => {
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  const reactionTypes = {
    like: { icon: HandThumbUpIcon, solidIcon: HandThumbUpSolidIcon, color: 'text-blue-500' },
    heart: { icon: HeartIcon, solidIcon: HeartSolidIcon, color: 'text-red-500' },
  };

  const handleReaction = (reactionType) => {
    onReact(messageId, reactionType);
    setShowReactionPicker(false);
  };

  const hasUserReacted = (reactionType) => {
    return reactions[reactionType]?.includes(currentUserId);
  };

  const getReactionCount = (reactionType) => {
    return reactions[reactionType]?.length || 0;
  };

  return (
    <div className="relative">
      {/* Reaction Picker */}
      {showReactionPicker && (
        <div className="absolute bottom-full left-0 mb-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 p-2 flex space-x-2 z-10">
          {Object.entries(reactionTypes).map(([type, { icon: Icon, color }]) => (
            <button
              key={type}
              onClick={() => handleReaction(type)}
              className={`p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-200 ${color}`}
              title={type.charAt(0).toUpperCase() + type.slice(1)}
            >
              <Icon className="w-5 h-5" />
            </button>
          ))}
        </div>
      )}

      {/* Reaction Button */}
      <button
        onClick={() => setShowReactionPicker(!showReactionPicker)}
        className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors duration-200"
        title="Add reaction"
      >
        <FaceSmileIcon className="w-4 h-4 text-gray-500 dark:text-gray-400" />
      </button>

      {/* Display Reactions */}
      <div className="flex space-x-1 mt-1">
        {Object.entries(reactionTypes).map(([type, { solidIcon: SolidIcon, icon: Icon, color }]) => {
          const count = getReactionCount(type);
          const hasReacted = hasUserReacted(type);
          
          if (count === 0) return null;

          return (
            <div
              key={type}
              className={`flex items-center space-x-1 px-2 py-1 rounded-full text-xs font-medium ${
                hasReacted 
                  ? 'bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300' 
                  : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
              }`}
            >
              {hasReacted ? (
                <SolidIcon className={`w-3 h-3 ${color}`} />
              ) : (
                <Icon className={`w-3 h-3 ${color}`} />
              )}
              <span>{count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MessageReactions; 