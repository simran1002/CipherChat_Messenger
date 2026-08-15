import { useRef, useEffect } from "react";
import { BellIcon, CheckIcon } from "@heroicons/react/24/outline";
import { formatTime } from "../utils/helpers";

/** In-memory DM notification row built by Header from `dmNotification` socket events. */
export interface NotificationItem {
  id: number;
  from: string;
  message: string;
  room: string;
  conversationId?: string;
  createdAt: string;
  read: boolean;
}

interface NotificationsPanelProps {
  notifications: NotificationItem[];
  onMarkAllRead: () => void;
  onClose: () => void;
}

const NotificationsPanel = ({ notifications, onMarkAllRead, onClose }: NotificationsPanelProps) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div ref={ref} className="absolute right-0 top-10 w-80 bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl z-50 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700">
        <div className="flex items-center gap-2">
          <BellIcon className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold text-white">Notifications</span>
          {unread > 0 && (
            <span className="text-xs bg-violet-600 text-white rounded-full px-1.5 py-0.5">{unread}</span>
          )}
        </div>
        {unread > 0 && (
          <button onClick={onMarkAllRead} className="text-xs text-violet-400 hover:text-violet-300 flex items-center gap-1">
            <CheckIcon className="w-3.5 h-3.5" /> Mark all read
          </button>
        )}
      </div>
      <div className="max-h-80 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="py-8 text-center text-gray-500 text-sm">No notifications</div>
        ) : (
          notifications.map((n) => (
            <div key={n.id} className={`px-4 py-3 border-b border-gray-700/50 ${!n.read ? "bg-violet-900/20" : ""}`}>
              <div className="flex items-start gap-2">
                {!n.read && <span className="w-2 h-2 bg-violet-400 rounded-full mt-1.5 shrink-0" />}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 font-medium truncate">{n.from}</p>
                  <p className="text-xs text-gray-400 truncate">{n.message}</p>
                  <p className="text-xs text-gray-600 mt-0.5">{n.room} · {formatTime(n.createdAt)}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default NotificationsPanel;
