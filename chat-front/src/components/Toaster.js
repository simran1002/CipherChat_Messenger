import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  CheckCircleIcon, 
  ExclamationTriangleIcon, 
  XMarkIcon 
} from '@heroicons/react/24/outline';

const Toaster = () => {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    // Global function to add toasts
    window.makeToast = (type, message) => {
      const id = Date.now() + Math.random();
      const newToast = { id, type, message };
      setToasts(prev => [...prev, newToast]);

      // Auto remove after 5 seconds
      setTimeout(() => {
        setToasts(prev => prev.filter(toast => toast.id !== id));
      }, 5000);
    };

    return () => {
      delete window.makeToast;
    };
  }, []);

  const removeToast = (id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  const getToastStyles = (type) => {
    switch (type) {
      case 'success':
        return {
          bg: 'bg-green-50',
          border: 'border-green-200',
          text: 'text-green-800',
          icon: CheckCircleIcon,
          iconColor: 'text-green-500'
        };
      case 'error':
        return {
          bg: 'bg-red-50',
          border: 'border-red-200',
          text: 'text-red-800',
          icon: ExclamationTriangleIcon,
          iconColor: 'text-red-500'
        };
      default:
        return {
          bg: 'bg-blue-50',
          border: 'border-blue-200',
          text: 'text-blue-800',
          icon: CheckCircleIcon,
          iconColor: 'text-blue-500'
        };
    }
  };

  return (
    <div className="fixed top-4 right-4 z-50 space-y-2">
      <AnimatePresence>
        {toasts.map((toast) => {
          const styles = getToastStyles(toast.type);
          const Icon = styles.icon;

          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, x: 300, scale: 0.3 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={{ opacity: 0, x: 300, scale: 0.5 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className={`${styles.bg} ${styles.border} border rounded-lg shadow-lg p-4 max-w-sm w-full`}
            >
              <div className="flex items-start">
                <div className="flex-shrink-0">
                  <Icon className={`h-5 w-5 ${styles.iconColor}`} />
                </div>
                <div className="ml-3 flex-1">
                  <p className={`text-sm font-medium ${styles.text}`}>
                    {toast.message}
                  </p>
                </div>
                <div className="ml-4 flex-shrink-0">
                  <button
                    onClick={() => removeToast(toast.id)}
                    className={`${styles.text} hover:bg-opacity-20 hover:bg-black rounded-md inline-flex items-center justify-center p-1 transition-colors duration-200`}
                  >
                    <XMarkIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
};

export default Toaster; 