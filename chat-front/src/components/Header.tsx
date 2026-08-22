import { useSocket } from "../contexts/SocketContext";
import { useState, useRef, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ChatBubbleLeftRightIcon,
  UserCircleIcon,
  ArrowRightOnRectangleIcon,
  ChevronDownIcon,
  SunIcon,
  MoonIcon,
  EnvelopeIcon,
  BellIcon,
  UserIcon,
  LockClosedIcon,
  ChartBarIcon,
} from "@heroicons/react/24/outline";
import { useTheme } from "../contexts/ThemeContext";
import { stringToColor, getInitials } from "../utils/helpers";
import NotificationsPanel from "./NotificationsPanel";
import { getApiUrl } from "../services/api";
import notificationService from "../services/NotificationService";
import type { AuthUser } from "../types";

interface HeaderNotification {
  id: number;
  from: string;
  message: string;
  room: string;
  conversationId: string;
  /** Set on @mention notifications — clicking navigates to the room. */
  chatroomId?: string;
  createdAt: string;
  read: boolean;
}

interface HeaderProps {
  user: AuthUser | null;
  onLogout?: () => void;
}

const Header = ({ user, onLogout }: HeaderProps) => {
  const { socket } = useSocket();
  const navigate = useNavigate();
  const { isDarkMode, toggleTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  const [notifications, setNotifications] = useState<HeaderNotification[]>([]);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const notifRef = useRef<HTMLDivElement | null>(null);

  // Listen for DM notifications via socket
  useEffect(() => {
    if (!socket) return;
    const handleDmNotif = ({ from, message, conversationId }: { conversationId: string; from: string; message: string }) => {
      setNotifications((prev) => [
        { id: Date.now(), from, message, room: "Direct Message", conversationId, createdAt: new Date().toISOString(), read: false },
        ...prev.slice(0, 49),
      ]);
    };
    // @mention in a chatroom — same panel, with room context + browser notification
    const handleMentionNotif = ({ chatroomId, chatroomName, from, preview }: { chatroomId: string; chatroomName: string; messageId: string; from: string; preview: string }) => {
      setNotifications((prev) => [
        { id: Date.now(), from, message: preview, room: chatroomName, conversationId: "", chatroomId, createdAt: new Date().toISOString(), read: false },
        ...prev.slice(0, 49),
      ]);
      notificationService.playSound("message");
      void notificationService.showNotification(`${from} mentioned you in ${chatroomName}`, {
        body: preview.length > 80 ? `${preview.substring(0, 80)}…` : preview,
        tag: `mention-${Date.now()}`,
      });
    };
    socket.on("dmNotification", handleDmNotif);
    socket.on("mentionNotification", handleMentionNotif);
    return () => {
      socket.off("dmNotification", handleDmNotif);
      socket.off("mentionNotification", handleMentionNotif);
    };
  }, [socket]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setShowNotifs(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const handleLogout = () => {
    setMenuOpen(false);
    localStorage.removeItem("CC_Token");
    localStorage.removeItem("CC_User");
    if (onLogout) onLogout();
    navigate("/");
  };

  const unreadCount = notifications.filter((n) => !n.read).length;

  const renderAvatar = (sizeClass = "w-8 h-8", textClass = "text-sm") => {
    const dpSrc = user?.dp ? (user.dp.startsWith("http") ? user.dp : `${getApiUrl()}${user.dp}`) : null;
    if (dpSrc) return <img src={dpSrc} alt="" className={`${sizeClass} rounded-full object-cover ring-2 ring-violet-500/30`} />;
    const name = user?.name || "U";
    return (
      <div
        className={`${sizeClass} rounded-full flex items-center justify-center text-white font-semibold ${textClass} ring-2 ring-violet-500/30`}
        style={{ background: `linear-gradient(135deg, ${stringToColor(name)}, #8b5cf6)` }}
      >
        {getInitials(name)}
      </div>
    );
  };

  return (
    <header className="bg-gray-900/95 backdrop-blur-md border-b border-gray-800 sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-[72px]">
          {/* Logo */}
          <Link to={user ? "/dashboard" : "/"} className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 bg-gradient-to-br from-violet-500 to-purple-700 rounded-xl flex items-center justify-center shadow-lg group-hover:shadow-violet-500/25 transition-all">
              <ChatBubbleLeftRightIcon className="w-5 h-5 text-white" />
            </div>
            <div className="flex flex-col">
              <span className="text-lg font-bold bg-gradient-to-r from-violet-400 to-purple-400 bg-clip-text text-transparent">
                CipherChat
              </span>
              <span className="text-[10px] text-gray-500 font-medium -mt-0.5 hidden sm:flex items-center gap-1">
                <LockClosedIcon className="w-2.5 h-2.5 text-violet-500" /> Secure Messaging
              </span>
            </div>
          </Link>

          <div className="flex items-center gap-1.5">
            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors"
            >
              {isDarkMode ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
            </button>

            {user ? (
              <>
                {/* DM link */}
                <Link to="/messages" className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors" aria-label="Direct messages">
                  <EnvelopeIcon className="w-5 h-5" />
                </Link>

                {/* Metrics dashboard link */}
                <Link to="/metrics" className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors" aria-label="System metrics" title="System Metrics">
                  <ChartBarIcon className="w-5 h-5" />
                </Link>

                {/* Notifications bell */}
                <div className="relative" ref={notifRef}>
                  <button
                    onClick={() => { setShowNotifs((v) => !v); if (!showNotifs) setNotifications((ns) => ns.map((n) => ({ ...n, read: true }))); }}
                    className="p-2 rounded-xl text-gray-400 hover:text-white hover:bg-gray-800 transition-colors relative"
                    aria-label="Notifications"
                  >
                    <BellIcon className="w-5 h-5" />
                    {unreadCount > 0 && (
                      <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                    )}
                  </button>
                  {showNotifs && (
                    <NotificationsPanel
                      notifications={notifications}
                      onMarkAllRead={() => setNotifications((ns) => ns.map((n) => ({ ...n, read: true })))}
                      onClose={() => setShowNotifs(false)}
                      onItemClick={(n) => {
                        if (!n.chatroomId) return;
                        setShowNotifs(false);
                        navigate(`/chatroom/${n.chatroomId}`);
                      }}
                    />
                  )}
                </div>

                {/* User menu */}
                <div className="relative" ref={menuRef}>
                  <button
                    className="flex items-center gap-2 bg-gray-800 hover:bg-gray-700 px-3 py-2 rounded-xl border border-gray-700 hover:border-gray-600 transition-all"
                    onClick={() => setMenuOpen((o) => !o)}
                    aria-expanded={menuOpen}
                    aria-haspopup="true"
                  >
                    {renderAvatar()}
                    <span className="hidden md:block text-sm font-medium text-gray-300 max-w-[100px] truncate">
                      {user.name}
                    </span>
                    <ChevronDownIcon className={`w-4 h-4 text-gray-500 transition-transform ${menuOpen ? "rotate-180" : ""}`} />
                  </button>

                  {menuOpen && (
                    <div className="absolute right-0 mt-2 w-56 bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl overflow-hidden">
                      <div className="p-4 border-b border-gray-700 bg-gradient-to-br from-violet-900/30 to-gray-800">
                        <div className="flex items-center gap-3">
                          {renderAvatar("w-10 h-10", "text-base")}
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{user.name}</p>
                            <p className="text-xs text-gray-500 truncate">{user.email}</p>
                          </div>
                        </div>
                      </div>
                      <div className="py-1">
                        <Link
                          to="/profile"
                          onClick={() => setMenuOpen(false)}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                        >
                          <UserIcon className="w-4 h-4 text-gray-400" />
                          <span>My Profile</span>
                        </Link>
                        <div className="border-t border-gray-700 my-1" />
                        <button
                          onClick={handleLogout}
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <ArrowRightOnRectangleIcon className="w-4 h-4" />
                          <span>Sign Out</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <Link to="/login" className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-gray-300 hover:text-white border border-gray-700 hover:border-gray-600 rounded-xl hover:bg-gray-800 transition-all">
                  <UserCircleIcon className="w-4 h-4" />
                  <span className="hidden sm:inline">Login</span>
                </Link>
                <Link to="/register" className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700 rounded-xl shadow-lg shadow-violet-500/20 transition-all">
                  Sign Up
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
