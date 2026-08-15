/**
 * Browser notification + sound service.
 *
 * `vibrate` and `actions` are Notification API options that newer lib.dom
 * typings only allow on service-worker notifications, so they are re-added
 * here as an extension of NotificationOptions — runtime behavior unchanged
 * (unsupported options are ignored by the browser).
 */
type RichNotificationOptions = NotificationOptions & {
  vibrate?: number[];
  actions?: Array<{ action: string; title: string }>;
};

interface NotificationClickData {
  type: string;
  sender: string;
  chatroom: string;
}

class NotificationService {
  permission: NotificationPermission;
  soundEnabled: boolean;
  private _audioCtx: AudioContext | null;

  constructor() {
    this.permission = 'default';
    this.soundEnabled = localStorage.getItem('cipherchat-sound') !== 'false';
    this._audioCtx = null;
    this.init();
  }

  private _getAudioCtx(): AudioContext {
    if (!this._audioCtx) {
      const AudioCtxCtor = (window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as typeof AudioContext;
      this._audioCtx = new AudioCtxCtor();
    }
    return this._audioCtx;
  }

  playSound(type: string = 'message'): void {
    if (!this.soundEnabled) return;
    try {
      const ctx = this._getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === 'message') {
        // Two-tone "ding" at 880Hz then 1100Hz
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } else {
        // Soft blip for typing/join/leave
        osc.frequency.setValueAtTime(600, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.15);
      }
    } catch {
      // AudioContext blocked until first user gesture — silently skip
    }
  }

  setSoundEnabled(enabled: boolean): void {
    this.soundEnabled = enabled;
    localStorage.setItem('cipherchat-sound', enabled ? 'true' : 'false');
  }

  isSoundEnabled(): boolean {
    return this.soundEnabled;
  }

  async init(): Promise<void> {
    if ('Notification' in window) {
      this.permission = await Notification.requestPermission();
    }
  }

  async requestPermission(): Promise<NotificationPermission> {
    if ('Notification' in window) {
      this.permission = await Notification.requestPermission();
      return this.permission;
    }
    return 'denied';
  }

  async showNotification(title: string, options: RichNotificationOptions = {}): Promise<Notification | undefined> {
    if (this.permission !== 'granted') {
      return;
    }

    const defaultOptions: RichNotificationOptions = {
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

  async showMessageNotification(senderName: string, message: string, chatroomName: string): Promise<Notification | undefined> {
    this.playSound('message');
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

  async showTypingNotification(username: string, chatroomName: string): Promise<Notification | undefined> {
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

  async showUserJoinedNotification(username: string, chatroomName: string): Promise<Notification | undefined> {
    return this.showNotification(
      `${username} joined the chat`,
      {
        body: `Welcome to ${chatroomName}!`,
        tag: `join-${Date.now()}`,
        icon: '/logo192.png'
      }
    );
  }

  async showUserLeftNotification(username: string, chatroomName: string): Promise<Notification | undefined> {
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
  setupNotificationHandlers(
    onMessageClick?: (data: NotificationClickData) => void,
    onReplyClick?: (data: NotificationClickData) => void
  ): void {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        if (event.data && event.data.type === 'NOTIFICATION_CLICK') {
          const { action, data } = event.data as { action: string; data: NotificationClickData };

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
  isSupported(): boolean {
    return 'Notification' in window;
  }

  // Get current permission status
  getPermissionStatus(): NotificationPermission {
    return this.permission;
  }

  // Clear all notifications
  clearAll(): void {
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
