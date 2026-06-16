import React, { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  EnvelopeIcon,
  PlusIcon,
  PaperAirplaneIcon,
  ArrowLeftIcon,
  MagnifyingGlassIcon,
} from "@heroicons/react/24/outline";
import makeToast from "../Toaster";
import api from "../services/api";
import { stringToColor, getInitials, formatTime, formatDateDivider } from "../utils/helpers";

const Avatar = ({ user, size = "w-10 h-10" }) => {
  if (user?.dp) {
    return <img src={user.dp} alt="" className={`${size} rounded-full object-cover ring-2 ring-gray-700`} />;
  }
  const name = user?.name || "?";
  return (
    <div
      className={`${size} rounded-full flex items-center justify-center text-white font-bold text-sm ring-2 ring-gray-700 flex-shrink-0`}
      style={{ background: `linear-gradient(135deg, ${stringToColor(name)} 60%, #8b5cf6 100%)` }}
    >
      {getInitials(name)}
    </div>
  );
};

const DirectMessagesPage = ({ socket, user }) => {
  const [conversations, setConversations] = useState([]);
  const [activeConv, setActiveConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [isLoadingConvs, setIsLoadingConvs] = useState(true);
  const [isLoadingMsgs, setIsLoadingMsgs] = useState(false);
  const [showNewDM, setShowNewDM] = useState(false);
  const [allUsers, setAllUsers] = useState([]);
  const [userSearch, setUserSearch] = useState("");
  const [typingUsers, setTypingUsers] = useState([]);
  const [currentUserId, setCurrentUserId] = useState("");

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  useEffect(() => {
    const token = localStorage.getItem("CC_Token");
    if (token) {
      try { setCurrentUserId(JSON.parse(atob(token.split(".")[1])).id); } catch {}
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      setIsLoadingConvs(true);
      const res = await api.get("/dm");
      setConversations(res.data);
    } catch {
      makeToast("error", "Failed to load conversations");
    } finally {
      setIsLoadingConvs(false);
    }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  const openConversation = async (conv) => {
    setActiveConv(conv);
    setMessages([]);
    setIsLoadingMsgs(true);
    try {
      const res = await api.get(`/dm/${conv._id}/messages`);
      setMessages(res.data.messages);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    } catch {
      makeToast("error", "Failed to load messages");
    } finally {
      setIsLoadingMsgs(false);
    }
    if (socket) {
      socket.emit("joinDM", { conversationId: conv._id });
    }
  };

  const handleBackToList = () => {
    if (activeConv && socket) socket.emit("leaveDM", { conversationId: activeConv._id });
    setActiveConv(null);
    setMessages([]);
  };

  // Socket events for DMs
  useEffect(() => {
    if (!socket) return;

    const handleNewDM = (data) => {
      if (!activeConv || data.conversationId !== activeConv._id) {
        // Update last message in conversation list
        setConversations((prev) =>
          prev.map((c) =>
            c._id === data.conversationId
              ? { ...c, lastMessage: { message: data.message, createdAt: data.createdAt } }
              : c
          )
        );
        return;
      }
      setMessages((prev) => [...prev, data]);
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
    };

    const handleDmTyping = (data) => {
      if (!activeConv) return;
      setTypingUsers((prev) => {
        if (prev.find((u) => u.userId === data.userId)) return prev;
        return [...prev, { userId: data.userId, name: data.name }];
      });
      setTimeout(() => {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== data.userId));
      }, 3000);
    };

    const handleDmStopTyping = ({ userId }) => {
      setTypingUsers((prev) => prev.filter((u) => u.userId !== userId));
    };

    socket.on("newDirectMessage", handleNewDM);
    socket.on("dmUserTyping", handleDmTyping);
    socket.on("dmUserStopTyping", handleDmStopTyping);

    return () => {
      socket.off("newDirectMessage", handleNewDM);
      socket.off("dmUserTyping", handleDmTyping);
      socket.off("dmUserStopTyping", handleDmStopTyping);
    };
  }, [socket, activeConv]);

  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMessage.trim() || !socket || !activeConv) return;
    socket.emit("directMessage", { conversationId: activeConv._id, message: newMessage.trim() });
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      socket.emit("dmStopTyping", { conversationId: activeConv._id });
    }
    setNewMessage("");
    inputRef.current?.focus();
  };

  const handleTyping = () => {
    if (!socket || !activeConv) return;
    socket.emit("dmTyping", { conversationId: activeConv._id });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit("dmStopTyping", { conversationId: activeConv._id });
    }, 2000);
  };

  const startNewDM = async (targetUser) => {
    try {
      const res = await api.post("/dm/start", { targetUserId: targetUser._id });
      setShowNewDM(false);
      await loadConversations();
      const conv = { _id: res.data._id, participant: res.data.participant };
      openConversation(conv);
    } catch (err) {
      makeToast("error", err?.response?.data?.message || "Failed to start conversation");
    }
  };

  const loadAllUsers = async () => {
    try {
      const res = await api.get("/dm/users");
      setAllUsers(res.data);
    } catch {
      makeToast("error", "Failed to load users");
    }
  };

  const filteredUsers = allUsers.filter((u) =>
    u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  const shouldShowDateDivider = (index) => {
    if (index === 0) return true;
    return new Date(messages[index].createdAt).toDateString() !== new Date(messages[index - 1].createdAt).toDateString();
  };

  return (
    <div className="flex h-[calc(100vh-72px)] bg-gray-900">
      {/* Conversation List */}
      <aside className={`${activeConv ? "hidden md:flex" : "flex"} w-full md:w-80 flex-col bg-gray-800/60 border-r border-gray-700/50`}>
        <div className="flex items-center justify-between p-4 border-b border-gray-700/50">
          <div className="flex items-center gap-2">
            <EnvelopeIcon className="w-5 h-5 text-primary-400" />
            <h2 className="font-semibold text-white">Messages</h2>
          </div>
          <motion.button
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            onClick={() => { setShowNewDM(true); loadAllUsers(); }}
            className="p-2 bg-primary-600 hover:bg-primary-700 rounded-lg text-white transition-colors"
            aria-label="New direct message"
          >
            <PlusIcon className="w-4 h-4" />
          </motion.button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {isLoadingConvs ? (
            <div className="flex justify-center p-8">
              <div className="w-8 h-8 border-4 border-primary-400 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : conversations.length === 0 ? (
            <div className="text-center p-8">
              <EnvelopeIcon className="w-12 h-12 text-gray-600 mx-auto mb-3" />
              <p className="text-gray-400 font-medium">No conversations yet</p>
              <p className="text-gray-600 text-sm mt-1">Start a new message</p>
            </div>
          ) : (
            conversations.map((conv) => (
              <button
                key={conv._id}
                onClick={() => openConversation(conv)}
                className={`w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-700/50 transition-colors text-left ${activeConv?._id === conv._id ? "bg-gray-700/70" : ""}`}
              >
                <Avatar user={conv.participant} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-white text-sm truncate">{conv.participant?.name}</p>
                  {conv.lastMessage && (
                    <p className="text-xs text-gray-500 truncate">{conv.lastMessage.message}</p>
                  )}
                </div>
                {conv.lastMessage && (
                  <span className="text-[10px] text-gray-600 flex-shrink-0">{formatTime(conv.lastMessage.createdAt)}</span>
                )}
              </button>
            ))
          )}
        </div>
      </aside>

      {/* Conversation View */}
      {activeConv ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* DM Header */}
          <div className="bg-gray-800/80 backdrop-blur-sm border-b border-gray-700/50 px-4 py-3 flex items-center gap-3 shrink-0">
            <button onClick={handleBackToList} className="md:hidden p-2 hover:bg-gray-700 rounded-lg transition-colors">
              <ArrowLeftIcon className="w-5 h-5 text-gray-400" />
            </button>
            <Avatar user={activeConv.participant} size="w-9 h-9" />
            <div>
              <h2 className="font-semibold text-white">{activeConv.participant?.name}</h2>
              <p className="text-xs text-gray-500">{activeConv.participant?.email}</p>
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-1">
            {isLoadingMsgs ? (
              <div className="flex justify-center h-full items-center">
                <div className="w-8 h-8 border-4 border-primary-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : messages.length === 0 ? (
              <div className="flex items-center justify-center h-full text-center">
                <div>
                  <Avatar user={activeConv.participant} size="w-16 h-16" />
                  <p className="text-gray-400 font-medium mt-4">Say hi to {activeConv.participant?.name}!</p>
                </div>
              </div>
            ) : (
              <>
                {messages.map((msg, index) => {
                  const isMine = msg.userId === currentUserId;
                  return (
                    <React.Fragment key={msg._id || index}>
                      {shouldShowDateDivider(index) && (
                        <div className="flex items-center justify-center my-4">
                          <div className="bg-gray-800 text-gray-400 text-xs px-3 py-1 rounded-full border border-gray-700">
                            {formatDateDivider(msg.createdAt)}
                          </div>
                        </div>
                      )}
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex ${isMine ? "justify-end" : "justify-start"} mb-2`}
                      >
                        <div className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-sm ${isMine ? "bg-gradient-to-r from-primary-500 to-primary-600 text-white rounded-br-md" : "bg-gray-800 text-gray-100 border border-gray-700/50 rounded-bl-md"}`}>
                          <p className="leading-relaxed">{msg.message}</p>
                          <p className={`text-[10px] mt-1 ${isMine ? "text-primary-200" : "text-gray-500"} text-right`}>{formatTime(msg.createdAt)}</p>
                        </div>
                      </motion.div>
                    </React.Fragment>
                  );
                })}
                {typingUsers.length > 0 && (
                  <div className="flex items-center gap-2 text-xs text-gray-500 pl-2">
                    <div className="flex space-x-1">
                      {[0, 0.15, 0.3].map((d, i) => (
                        <div key={i} className="w-1.5 h-1.5 bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: `${d}s` }} />
                      ))}
                    </div>
                    <span>{typingUsers.map((u) => u.name).join(", ")} is typing…</span>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </>
            )}
          </div>

          {/* Input */}
          <div className="bg-gray-800/80 backdrop-blur-sm border-t border-gray-700/50 p-3 sm:p-4 shrink-0">
            <form onSubmit={sendMessage} className="flex items-center gap-3">
              <input
                ref={inputRef}
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                onInput={handleTyping}
                placeholder={`Message ${activeConv.participant?.name}…`}
                className="flex-1 bg-gray-700/50 border border-gray-600 text-white rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-500 transition-all"
                maxLength={2000}
              />
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="submit"
                disabled={!newMessage.trim() || !socket}
                className="bg-gradient-to-r from-primary-500 to-primary-600 hover:from-primary-600 hover:to-primary-700 text-white p-3 rounded-xl disabled:opacity-30 transition-all shadow-lg shadow-primary-500/20"
              >
                <PaperAirplaneIcon className="w-5 h-5" />
              </motion.button>
            </form>
          </div>
        </div>
      ) : (
        <div className="hidden md:flex flex-1 items-center justify-center text-center">
          <div>
            <EnvelopeIcon className="w-16 h-16 text-gray-600 mx-auto mb-4" />
            <p className="text-gray-400 font-medium">Select a conversation</p>
            <p className="text-gray-600 text-sm mt-1">or start a new one</p>
          </div>
        </div>
      )}

      {/* New DM modal */}
      <AnimatePresence>
        {showNewDM && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
            onClick={() => setShowNewDM(false)}
          >
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-5 border-b border-gray-700">
                <h3 className="font-semibold text-white">New Message</h3>
              </div>
              <div className="p-4">
                <div className="relative mb-4">
                  <MagnifyingGlassIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                  <input
                    type="text"
                    placeholder="Search users…"
                    value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    className="w-full bg-gray-700/50 border border-gray-600 text-white rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 placeholder-gray-500"
                  />
                </div>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {filteredUsers.map((u) => (
                    <button
                      key={u._id}
                      onClick={() => startNewDM(u)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-700/50 transition-colors text-left"
                    >
                      <Avatar user={u} size="w-9 h-9" />
                      <div className="min-w-0">
                        <p className="font-medium text-white text-sm truncate">{u.name}</p>
                        <p className="text-xs text-gray-500 truncate">{u.email}</p>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export default DirectMessagesPage;
