import React from "react";
import { UsersIcon } from "@heroicons/react/24/outline";
import { stringToColor, getInitials } from "../utils/helpers";
import { getPresence } from "./PresencePicker";
import PresencePicker from "./PresencePicker";
import { getApiUrl } from "../services/api";

const Avatar = ({ user }) => {
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

const OnlineUsersSidebar = ({ onlineUsers, currentUserId, currentPresence, socket, onPresenceUpdate }) => (
  <aside className="w-full h-full bg-gray-900/90 backdrop-blur-sm flex flex-col">
    <div className="flex items-center gap-2 p-4 border-b border-gray-700/50 shrink-0">
      <UsersIcon className="w-4 h-4 text-violet-400" />
      <span className="font-semibold text-white text-sm">Online ({onlineUsers.length})</span>
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
    </div>
  </aside>
);

export default OnlineUsersSidebar;
