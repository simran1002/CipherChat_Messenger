import React from 'react';
import { 
  CheckIcon, 
  CheckIcon as DoubleCheckIcon 
} from '@heroicons/react/24/outline';
import { 
  CheckIcon as CheckSolidIcon, 
  CheckIcon as DoubleCheckSolidIcon 
} from '@heroicons/react/24/solid';

const MessageStatus = ({ status, timestamp, isOwnMessage }) => {
  if (!isOwnMessage) return null;

  const getStatusIcon = () => {
    switch (status) {
      case 'sent':
        return (
          <CheckIcon className="w-4 h-4 text-gray-400 dark:text-gray-500" />
        );
      case 'delivered':
        return (
          <DoubleCheckIcon className="w-4 h-4 text-gray-400 dark:text-gray-500" />
        );
      case 'read':
        return (
          <DoubleCheckSolidIcon className="w-4 h-4 text-blue-500 dark:text-blue-400" />
        );
      case 'failed':
        return (
          <div className="w-4 h-4 text-red-500 flex items-center justify-center">
            <span className="text-xs">!</span>
          </div>
        );
      default:
        return (
          <div className="w-4 h-4 flex items-center justify-center">
            <div className="w-2 h-2 bg-gray-300 dark:bg-gray-600 rounded-full animate-pulse"></div>
          </div>
        );
    }
  };

  const getStatusText = () => {
    switch (status) {
      case 'sent':
        return 'Sent';
      case 'delivered':
        return 'Delivered';
      case 'read':
        return 'Read';
      case 'failed':
        return 'Failed to send';
      default:
        return 'Sending...';
    }
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    
    const date = new Date(timestamp);
    const now = new Date();
    const diffInMinutes = (now - date) / (1000 * 60);
    
    if (diffInMinutes < 1) {
      return 'Just now';
    } else if (diffInMinutes < 60) {
      return `${Math.floor(diffInMinutes)}m`;
    } else if (diffInMinutes < 1440) {
      return `${Math.floor(diffInMinutes / 60)}h`;
    } else {
      return date.toLocaleDateString();
    }
  };

  return (
    <div className="flex items-center space-x-1 mt-1">
      {getStatusIcon()}
      <span className="text-xs text-gray-500 dark:text-gray-400">
        {formatTime(timestamp)}
      </span>
      {status === 'failed' && (
        <span className="text-xs text-red-500 ml-1">
          {getStatusText()}
        </span>
      )}
    </div>
  );
};

export default MessageStatus; 