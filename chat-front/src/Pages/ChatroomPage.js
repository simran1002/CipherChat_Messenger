import React, { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeftIcon,
  PaperAirplaneIcon,
  UserCircleIcon,
  ClockIcon,
  UsersIcon,
  SparklesIcon
} from "@heroicons/react/24/outline";
import makeToast from "../Toaster";

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const c = (hash & 0x00FFFFFF).toString(16).toUpperCase();
  return "#" + "00000".substring(0, 6 - c.length) + c;
}

const ChatroomPage = ({ socket }) => {
  const { chatroomId } = useParams();
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [userId, setUserId] = useState("");
  const [chatroomName, setChatroomName] = useState("Chatroom");
  const [isTyping, setIsTyping] = useState(false);
  const [user, setUser] = useState(null);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  // For sidebar user list (mocked for now)
  const [users, setUsers] = useState([]);

  useEffect(() => {
    // Get user info from localStorage
    const userStr = localStorage.getItem("CC_User");
    if (userStr) {
      try {
        setUser(JSON.parse(userStr));
      } catch {}
    }
  }, []);

  useEffect(() => {
    // Mock user list (current user only for now)
    if (user) {
      setUsers([
        {
          id: userId,
          name: user.name,
          email: user.email,
          dp: user.dp,
          online: true,
        },
      ]);
    }
  }, [user, userId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const token = localStorage.getItem("CC_Token");
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split(".")[1]));
        setUserId(payload.id);
      } catch (error) {
        console.error("Error parsing token:", error);
      }
    }
  }, []);

  useEffect(() => {
    if (socket) {
      socket.on("newMessage", (message) => {
        setMessages(prev => [...prev, message]);
      });

      socket.on("userTyping", (data) => {
        if (data.chatroomId === chatroomId) {
          setIsTyping(true);
          setTimeout(() => setIsTyping(false), 3000);
        }
      });
    }

    return () => {
      if (socket) {
        socket.off("newMessage");
        socket.off("userTyping");
      }
    };
  }, [socket, chatroomId]);

  useEffect(() => {
    if (socket) {
      socket.emit("joinRoom", { chatroomId });
    }

    return () => {
      if (socket) {
        socket.emit("leaveRoom", { chatroomId });
      }
    };
  }, [socket, chatroomId]);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !socket) return;

    socket.emit("chatroomMessage", {
      chatroomId,
      message: newMessage.trim(),
    });

    setNewMessage("");
    inputRef.current?.focus();
  };

  const handleTyping = () => {
    if (socket) {
      socket.emit("typing", { chatroomId });
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  };

  // Render avatar (DP or initials)
  const renderAvatar = (u) => {
    if (u?.dp) {
      return (
        <img src={u.dp} alt="DP" className="w-9 h-9 rounded-full object-cover border-2 border-primary-400 shadow" />
      );
    }
    const initials = (u?.name || u?.email || 'U').split(' ').map(x => x[0]).join('').toUpperCase();
    const bgColor = stringToColor(u?.name || u?.email || 'U');
    return (
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-lg shadow" style={{ background: `linear-gradient(135deg, ${bgColor} 60%, #a78bfa 100%)` }}>{initials}</div>
    );
  };

  return (
    <div className="chat-container flex flex-row">
      {/* Sidebar User List */}
      <aside className="sidebar hidden md:flex flex-col w-64 bg-white border-r border-gray-200 p-0 z-20">
        <div className="sidebar-header flex items-center gap-2 border-b border-gray-100">
          <UsersIcon className="w-5 h-5 text-primary-500" />
          <span className="font-semibold text-lg text-gray-800">Users</span>
          <SparklesIcon className="w-4 h-4 text-secondary-400 ml-auto animate-pulse" />
        </div>
        <div className="sidebar-content flex-1 overflow-y-auto">
          {users.map((u, idx) => (
            <div key={idx} className="flex items-center gap-3 p-4 border-b border-gray-100 hover:bg-primary-50 transition-colors duration-200">
              {renderAvatar(u)}
              <div>
                <div className="font-medium text-gray-900">{u.name}</div>
                <div className="text-xs text-gray-500 flex items-center gap-1">
                  <span className={u.online ? "text-green-500" : "text-gray-400"}>●</span>
                  {u.online ? "Online" : "Offline"}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="chat-header">
          <div className="flex items-center space-x-4">
            <Link
              to="/dashboard"
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors duration-200"
            >
              <ArrowLeftIcon className="w-5 h-5 text-gray-600" />
            </Link>
            <div>
              <h1 className="text-lg font-semibold text-gray-900">
                {chatroomName}
              </h1>
              <p className="text-sm text-gray-500">
                {messages.length} messages
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            <span className="text-sm text-gray-500">Online</span>
          </div>
        </div>

        {/* Messages */}
        <div className="chat-messages">
          <AnimatePresence>
            {messages.map((message, index) => {
              // Find sender user (mock: only current user for now)
              const sender = users.find(u => u.id === message.userId) || user;
              return (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ duration: 0.3 }}
                  className={`flex ${userId === message.userId ? 'justify-end' : 'justify-start'} mb-4`}
                >
                  <div className={`flex ${userId === message.userId ? 'flex-row-reverse' : 'flex-row'} items-end space-x-2 max-w-xs lg:max-w-md`}>
                    {/* Avatar */}
                    <div className="flex-shrink-0">
                      {renderAvatar(sender)}
                    </div>
                    {/* Message Bubble */}
                    <div className="flex flex-col">
                      {userId !== message.userId && (
                        <span className="text-xs text-gray-500 mb-1 ml-1">
                          {message.name}
                        </span>
                      )}
                      <div
                        className={`message-bubble ${
                          userId === message.userId ? 'message-own' : 'message-other'
                        }`}
                      >
                        <p className="text-sm">{message.message}</p>
                      </div>
                      <div className={`flex items-center space-x-1 mt-1 ${
                        userId === message.userId ? 'justify-end' : 'justify-start'
                      }`}>
                        <ClockIcon className="w-3 h-3 text-gray-400" />
                        <span className="text-xs text-gray-400">
                          {formatTime(message.timestamp || Date.now())}
                        </span>
                      </div>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>

          {/* Typing Indicator */}
          <AnimatePresence>
            {isTyping && (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="flex justify-start mb-4"
              >
                <div className="flex items-end space-x-2">
                  {renderAvatar(user)}
                  <div className="bg-gray-200 rounded-2xl px-4 py-2">
                    <div className="loading-dots">
                      <div></div>
                      <div></div>
                      <div></div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="chat-input">
          <form onSubmit={sendMessage} className="flex space-x-4">
            <div className="flex-1">
              <input
                ref={inputRef}
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyPress={handleKeyPress}
                onInput={handleTyping}
                placeholder="Type your message..."
                className="input-field w-full"
                disabled={!socket}
              />
            </div>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              type="submit"
              disabled={!newMessage.trim() || !socket}
              className="btn-primary px-6 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <PaperAirplaneIcon className="w-5 h-5" />
            </motion.button>
          </form>
          
          {!socket && (
            <p className="text-sm text-red-500 mt-2 text-center">
              Connecting to chat server...
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default ChatroomPage;
