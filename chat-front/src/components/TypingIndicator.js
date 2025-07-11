import React from 'react';

const TypingIndicator = ({ isTyping, username }) => {
  if (!isTyping) return null;

  return (
    <div className="flex items-center space-x-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-lg max-w-xs">
      <div className="flex space-x-1">
        <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"></div>
        <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
        <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
      </div>
      <span className="text-sm text-gray-600 dark:text-gray-400 font-medium">
        {username} is typing...
      </span>
    </div>
  );
};

export default TypingIndicator; 