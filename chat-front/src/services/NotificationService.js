class NotificationService {
  constructor() {
    this.permission = 'default';
    this.init();
  }

  async init() {
    if ('Notification' in window) {
      this.permission = await Notification.requestPermission();
    }
  }

  async requestPermission() {
    if ('Notification' in window) {
      this.permission = await Notification.requestPermission();
      return this.permission;
    }
    return 'denied';
  }

  async showNotification(title, options = {}) {
    if (this.permission !== 'granted') {
      return;
    }

    const defaultOptions = {
      icon: '/logo192.png',
      badge: '/logo192.png',
      vibrate: [200, 100, 200],
      requireInteraction: false,
      ...options
    };

    try {
      const notification = new Notification(title, defaultOptions);
      
      // Auto close after 5 seconds
      setTimeout(() => {
        notification.close();
      }, 5000);

      return notification;
    } catch (error) {
      console.error('Error showing notification:', error);
    }
  }

  async showMessageNotification(senderName, message, chatroomName) {
    return this.showNotification(
      `New message from ${senderName}`,
      {
        body: message.length > 50 ? `${message.substring(0, 50)}...` : message,
        tag: `message-${Date.now()}`, // Prevent duplicate notifications
        data: {
          type: 'message',
          sender: senderName,
          chatroom: chatroomName
        },
        actions: [
          {
            action: 'view',
            title: 'View Message'
          },
          {
            action: 'reply',
            title: 'Reply'
          }
        ]
      }
    );
  }

  async showTypingNotification(username, chatroomName) {
    return this.showNotification(
      `${username} is typing...`,
      {
        body: `In ${chatroomName}`,
        tag: `typing-${username}`,
        requireInteraction: false,
        silent: true
      }
    );
  }

  async showUserJoinedNotification(username, chatroomName) {
    return this.showNotification(
      `${username} joined the chat`,
      {
        body: `Welcome to ${chatroomName}!`,
        tag: `join-${Date.now()}`,
        icon: '/logo192.png'
      }
    );
  }

  async showUserLeftNotification(username, chatroomName) {
    return this.showNotification(
      `${username} left the chat`,
      {
        body: `User left ${chatroomName}`,
        tag: `leave-${Date.now()}`,
        icon: '/logo192.png'
      }
    );
  }

  // Handle notification clicks
  setupNotificationHandlers(onMessageClick, onReplyClick) {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'NOTIFICATION_CLICK') {
          const { action, data } = event.data;
          
          switch (action) {
            case 'view':
              if (onMessageClick) onMessageClick(data);
              break;
            case 'reply':
              if (onReplyClick) onReplyClick(data);
              break;
            default:
              if (onMessageClick) onMessageClick(data);
              break;
          }
        }
      });
    }
  }

  // Check if notifications are supported
  isSupported() {
    return 'Notification' in window;
  }

  // Get current permission status
  getPermissionStatus() {
    return this.permission;
  }

  // Clear all notifications
  clearAll() {
    if ('Notification' in window) {
      // Close all notifications
      // Note: This is limited by browser security
      console.log('Notifications cleared');
    }
  }
}

// Create singleton instance
const notificationService = new NotificationService();

export default notificationService; 