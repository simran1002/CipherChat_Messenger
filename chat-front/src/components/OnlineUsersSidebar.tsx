import { UsersIcon } from "@heroicons/react/24/outline";
import { stringToColor, getInitials } from "../utils/helpers";
import { getPresence } from "./PresencePicker";
import PresencePicker, { type PresenceUpdate } from "./PresencePicker";
import { getApiUrl } from "../services/api";
import type { AppSocket, OnlineUserPublic } from "../types";

const Avatar = ({ user }: { user: OnlineUserPublic | null | undefined }) => {
  const dpSrc = user?.dp ? (user.dp.startsWith("http") ? user.dp : `${getApiUrl()}${user.dp}`) : null;
  if (dpSrc) return <img src={dpSrc} alt="" className="w-9 h-9 rounded-full object-cover ring-2 ring-gray-700 shrink-0" />;
  const name = user?.name || "U";
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-xs ring-2 ring-gray-700 shrink-0"
      style={{ background: `linear-gradient(135deg, ${stringToColor(name)} 60%, #8b5cf6 100%)` }}
    >
      {getInitials(name)}
    </div>
  );
};

interface OnlineUsersSidebarProps {
  onlineUsers: OnlineUserPublic[];
  /** Real headcount — the list itself is capped server-side (bounded roster). */
  onlineTotal?: number;
  currentUserId?: string | null;
  currentPresence?: Partial<PresenceUpdate> | null;
  socket?: AppSocket | null;
  onPresenceUpdate?: (update: PresenceUpdate) => void;
}

const OnlineUsersSidebar = ({ onlineUsers, onlineTotal, currentUserId, currentPresence, socket, onPresenceUpdate }: OnlineUsersSidebarProps) => {
  const total = onlineTotal ?? onlineUsers.length;
  return (
  <aside className="w-full h-full bg-gray-900/90 backdrop-blur-sm flex flex-col">
    <div className="flex items-center gap-2 p-4 border-b border-gray-700/50 shrink-0">
      <UsersIcon className="w-4 h-4 text-violet-400" />
      <span className="font-semibold text-white text-sm">Online ({total})</span>
    </div>

    <div className="flex-1 overflow-y-auto">
      {onlineUsers.length === 0 ? (
        <p className="text-gray-500 text-sm p-4 text-center">No users online</p>
      ) : (
        onlineUsers.map((u) => {
          const presence = getPresence(u.presenceStatus || "available");
          const isMe = u.userId === currentUserId;
          return (
            <div key={u.userId} className="px-3 py-2.5 hover:bg-gray-700/30 transition-colors">
              <div className="flex items-center gap-2.5">
                <div className="relative">
                  <Avatar user={u} />
                  <span
                    title={presence.label}
                    className="absolute -bottom-0.5 -right-0.5 text-sm leading-none"
                  >
                    {presence.emoji}
                  </span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-white truncate">
                    {u.name}
                    {isMe && <span className="text-xs text-gray-500 ml-1">(you)</span>}
                  </div>
                  {u.presenceNote ? (
                    <p className={`text-xs truncate ${presence.color}`}>{u.presenceNote}</p>
                  ) : (
                    <p className={`text-xs ${presence.color}`}>{presence.label}</p>
                  )}
                </div>
              </div>

              {/* Presence picker for own user */}
              {isMe && (
                <div className="mt-1.5 ml-11">
                  <PresencePicker
                    currentStatus={currentPresence?.presenceStatus || u.presenceStatus}
                    currentNote={currentPresence?.presenceNote || u.presenceNote}
                    socket={socket}
                    onUpdate={onPresenceUpdate}
                  />
                </div>
              )}
            </div>
          );
        })
      )}
      {total > onlineUsers.length && (
        <p className="text-xs text-gray-500 px-4 py-3 text-center">
          + {total - onlineUsers.length} more online
        </p>
      )}
    </div>
  </aside>
  );
};

export default OnlineUsersSidebar;
