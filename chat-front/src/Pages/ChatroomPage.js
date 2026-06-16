import React, { useState, useEffect, useRef, useCallback } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeftIcon,
  UsersIcon,
  ChevronUpIcon,
  MagnifyingGlassIcon,
  LockClosedIcon,
  SparklesIcon,
  SignalIcon,
  SignalSlashIcon,
} from "@heroicons/react/24/outline";
import makeToast from "../Toaster";
import api from "../services/api";
import notificationService from "../services/NotificationService";
import * as heartbeatSvc from "../services/HeartbeatService";
import { drain as drainOfflineQueue } from "../services/OfflineQueue";
import { useMessageDelivery } from "../hooks/useMessageDelivery";
import MessageList from "../components/MessageList";
import MessageInput from "../components/MessageInput";
import MessageDelete from "../components/MessageDelete";
import OnlineUsersSidebar from "../components/OnlineUsersSidebar";
import PinnedMessages from "../components/PinnedMessages";
import MessageSearchBar from "../components/MessageSearchBar";
import ScrollToBottomFAB from "../components/ScrollToBottomFAB";
import AICoPilot from "../components/AICoPilot";

const MESSAGES_PER_PAGE = 50;

const ChatroomPage = ({ socket, user }) => {
  const { chatroomId } = useParams();

  // Core state
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState("");
  const [userId, setUserId] = useState("");
  const [chatroomName, setChatroomName] = useState("Loading…");
  const [typingUsers, setTypingUsers] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [isConnected, setIsConnected] = useState(true);

  // UI state
  const [showSidebar, setShowSidebar] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [showFAB, setShowFAB] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [expiresIn, setExpiresIn] = useState(null);
  const [showAI, setShowAI] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Delivery tracking: clientMessageId → 'sending' | 'sent' | 'delivered' | 'read'
  const [deliveryStatus, setDeliveryStatus] = useState({});

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const inputRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const isFirstLoad = useRef(true);
  const isAtBottomRef = useRef(true);
  const latestSeqRef = useRef(0); // tracks highest sequenceNumber seen

  // Delivery hook — ACK + retry + offline queue fallback
  const { send: sendWithGuarantee, pendingCount } = useMessageDelivery(socket, chatroomId);

  // Decode userId from JWT
  useEffect(() => {
    const token = localStorage.getItem("CC_Token");
    if (token) {
      try { setUserId(JSON.parse(atob(token.split(".")[1])).id); } catch {}
    }
    notificationService.requestPermission();
  }, []);

  // Heartbeat — start when socket connects, drain offline queue
  useEffect(() => {
    if (!socket) return;

    heartbeatSvc.start(socket);

    const handleConnect = async () => {
      setIsConnected(true);
      await drainOfflineQueue(socket);
    };
    const handleDisconnect = () => setIsConnected(false);

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    setIsConnected(socket.connected);

    // Drain any queued messages from previous offline session
    if (socket.connected) drainOfflineQueue(socket);

    return () => {
      heartbeatSvc.stop();
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
    };
  }, [socket]);

  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? "smooth" : "auto" });
    setUnreadCount(0);
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 80;
    isAtBottomRef.current = atBottom;
    setShowFAB(!atBottom);
    if (atBottom) {
      setUnreadCount(0);
      // Emit read receipt for all visible messages when scrolled to bottom
      if (socket?.connected && latestSeqRef.current > 0) {
        socket.emit("markRead", { chatroomId, upToSequence: latestSeqRef.current });
      }
    }
  }, [socket, chatroomId]);

  const loadMessages = useCallback(async (pageNum = 1, prepend = false) => {
    try {
      if (pageNum === 1) setIsLoadingMessages(true);
      else setIsLoadingMore(true);

      const response = await api.get(`/chatroom/${chatroomId}/messages`, {
        params: { page: pageNum, limit: MESSAGES_PER_PAGE },
      });
      const { messages: msgs, chatroom, pagination } = response.data;
      setChatroomName(chatroom.name);
      setTotalPages(pagination.pages);

      const mapped = msgs.map((m) => ({
        _id: m._id,
        type: m.type || "text",
        message: m.message || "",
        fileUrl: m.fileUrl || "",
        fileName: m.fileName || "",
        mimeType: m.mimeType || "",
        fileSize: m.fileSize || 0,
        lat: m.lat,
        lng: m.lng,
        edited: m.edited || false,
        reactions: m.reactions || [],
        replyTo: m.replyTo || null,
        pinned: m.pinned || false,
        sequenceNumber: m.sequenceNumber || 0,
        readBy: m.readBy || [],
        deliveredTo: m.deliveredTo || [],
        name: m.user?.name || "Unknown",
        userId: m.user?._id,
        dp: m.user?.dp || "",
        createdAt: m.createdAt,
      }));

      setMessages((prev) => (prepend ? [...mapped, ...prev] : mapped));

      // Track latest sequence for read receipt emission
      if (mapped.length > 0) {
        const maxSeq = Math.max(...mapped.map((m) => m.sequenceNumber || 0));
        if (maxSeq > latestSeqRef.current) latestSeqRef.current = maxSeq;
      }
    } catch {
      makeToast("error", "Failed to load messages");
    } finally {
      setIsLoadingMessages(false);
      setIsLoadingMore(false);
    }
  }, [chatroomId]);

  const loadPinned = useCallback(async () => {
    try {
      const res = await api.get(`/chatroom/${chatroomId}/pinned`);
      setPinnedMessages(res.data);
    } catch {}
  }, [chatroomId]);

  useEffect(() => {
    loadMessages(1, false);
    loadPinned();
    setPage(1);
  }, [loadMessages, loadPinned]);

  useEffect(() => {
    if (isFirstLoad.current && !isLoadingMessages && messages.length > 0) {
      scrollToBottom(false);
      isFirstLoad.current = false;
      // Mark all as read on first load (we're at the bottom)
      if (socket?.connected && latestSeqRef.current > 0) {
        socket.emit("markRead", { chatroomId, upToSequence: latestSeqRef.current });
      }
    }
  }, [isLoadingMessages, messages.length, scrollToBottom, socket, chatroomId]);

  const handleLoadMore = async () => {
    if (page >= totalPages || isLoadingMore) return;
    const nextPage = page + 1;
    setPage(nextPage);
    await loadMessages(nextPage, true);
  };

  const handleSearch = async (q) => {
    setSearchQuery(q);
    if (!q) { setSearchResults(null); return; }
    try {
      const res = await api.get(`/chatroom/${chatroomId}/messages/search`, { params: { q } });
      const mapped = res.data.messages.map((m) => ({
        _id: m._id, type: m.type || "text", message: m.message || "",
        fileUrl: m.fileUrl, fileName: m.fileName, mimeType: m.mimeType,
        lat: m.lat, lng: m.lng, edited: m.edited, reactions: m.reactions || [],
        replyTo: m.replyTo, name: m.user?.name || "?", userId: m.user?._id,
        dp: m.user?.dp || "", createdAt: m.createdAt,
      }));
      setSearchResults(mapped);
    } catch { makeToast("error", "Search failed"); }
  };

  // Socket events
  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg) => {
      const mapped = {
        _id: msg._id,
        type: msg.type || "text",
        message: msg.message || "",
        fileUrl: msg.fileUrl || "",
        fileName: msg.fileName || "",
        mimeType: msg.mimeType || "",
        fileSize: msg.fileSize || 0,
        lat: msg.lat,
        lng: msg.lng,
        reactions: msg.reactions || [],
        replyTo: msg.replyTo || null,
        name: msg.name,
        userId: msg.userId,
        dp: msg.dp || "",
        edited: false,
        sequenceNumber: msg.sequenceNumber || 0,
        readBy: [],
        deliveredTo: msg.deliveredTo || [],
        clientMessageId: msg.clientMessageId || null,
        createdAt: msg.createdAt,
      };

      // Update latest sequence
      if (msg.sequenceNumber > latestSeqRef.current) {
        latestSeqRef.current = msg.sequenceNumber;
      }

      setMessages((prev) => {
        // If a pending optimistic message exists with same clientMessageId, replace it
        if (msg.clientMessageId) {
          const idx = prev.findIndex((m) => m.clientMessageId === msg.clientMessageId && m._pending);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = mapped;
            return next;
          }
        }
        return [...prev, mapped];
      });

      // Update delivery status
      if (msg.clientMessageId) {
        setDeliveryStatus((prev) => ({ ...prev, [msg.clientMessageId]: "sent" }));
      }

      if (isAtBottomRef.current) {
        setTimeout(() => scrollToBottom(), 50);
        // Auto read receipt when at bottom
        if (socket?.connected && msg.sequenceNumber) {
          socket.emit("markRead", { chatroomId, upToSequence: msg.sequenceNumber });
        }
      } else {
        setUnreadCount((c) => c + 1);
      }

      // Emit delivery receipt for others' messages
      if (msg.userId !== userId && msg._id) {
        socket.emit("messageDelivered", { messageId: msg._id, chatroomId });
      }

      if (document.hidden && msg.userId !== userId) {
        notificationService.showMessageNotification(msg.name, msg.message || "Sent a file", chatroomName);
      }
    };

    const handleDeliveryUpdate = ({ messageId, deliveredTo }) => {
      setMessages((prev) =>
        prev.map((m) => m._id === messageId ? { ...m, deliveredTo } : m)
      );
    };

    const handleMessagesRead = ({ userId: readerId, upToSequence }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (
            upToSequence == null || m.sequenceNumber <= upToSequence
          ) {
            const alreadyRead = m.readBy?.some((r) => r.user === readerId || r.user?._id === readerId);
            if (!alreadyRead) {
              return { ...m, readBy: [...(m.readBy || []), { user: readerId, readAt: new Date() }] };
            }
          }
          return m;
        })
      );
    };

    const handleUserTyping = (data) => {
      if (data.chatroomId !== chatroomId || data.userId === userId) return;
      setTypingUsers((prev) => {
        if (prev.find((u) => u.userId === data.userId)) return prev;
        return [...prev, { userId: data.userId, name: data.name }];
      });
    };

    const handleStopTyping = (data) => {
      if (data.chatroomId === chatroomId) {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== data.userId));
      }
    };

    const handleEdited = ({ messageId, newText }) => {
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, message: newText, edited: true } : m));
    };

    const handleDeleted = ({ messageId }) => {
      setMessages((prev) => prev.filter((m) => m._id !== messageId));
    };

    const handleReactionUpdated = ({ messageId, reactions }) => {
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, reactions } : m));
    };

    const handlePinned = ({ messageId, pinned }) => {
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, pinned } : m));
      loadPinned();
    };

    socket.on("newMessage", handleNewMessage);
    socket.on("messageDeliveryUpdate", handleDeliveryUpdate);
    socket.on("messagesRead", handleMessagesRead);
    socket.on("userTyping", handleUserTyping);
    socket.on("userStopTyping", handleStopTyping);
    socket.on("onlineUsers", setOnlineUsers);
    socket.on("messageEdited", handleEdited);
    socket.on("messageDeleted", handleDeleted);
    socket.on("reactionUpdated", handleReactionUpdated);
    socket.on("messagePinned", handlePinned);

    return () => {
      socket.off("newMessage", handleNewMessage);
      socket.off("messageDeliveryUpdate", handleDeliveryUpdate);
      socket.off("messagesRead", handleMessagesRead);
      socket.off("userTyping", handleUserTyping);
      socket.off("userStopTyping", handleStopTyping);
      socket.off("onlineUsers", setOnlineUsers);
      socket.off("messageEdited", handleEdited);
      socket.off("messageDeleted", handleDeleted);
      socket.off("reactionUpdated", handleReactionUpdated);
      socket.off("messagePinned", handlePinned);
    };
  }, [socket, chatroomId, userId, chatroomName, scrollToBottom, loadPinned]);

  useEffect(() => {
    if (!socket) return;
    socket.emit("joinRoom", { chatroomId });
    return () => socket.emit("leaveRoom", { chatroomId });
  }, [socket, chatroomId]);

  // Send text message — uses delivery hook (ACK + retry + offline queue)
  const sendMessage = useCallback(async (e) => {
    e?.preventDefault();
    const text = newMessage.trim();
    if (!text) return;

    const clientMessageId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

    // Optimistic UI — add a pending bubble immediately
    const optimistic = {
      _id: clientMessageId,
      _pending: true,
      type: "text",
      message: text,
      name: user?.name || "You",
      userId,
      dp: user?.dp || "",
      reactions: [],
      replyTo: replyTo ? { ...replyTo } : null,
      sequenceNumber: 0,
      clientMessageId,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);
    setDeliveryStatus((prev) => ({ ...prev, [clientMessageId]: "sending" }));

    setNewMessage("");
    setReplyTo(null);
    setExpiresIn(null);
    if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); }
    socket?.emit("stopTyping", { chatroomId });
    setTimeout(() => scrollToBottom(), 50);
    inputRef.current?.focus();

    const result = await sendWithGuarantee({
      message: text,
      replyTo: replyTo ? { messageId: replyTo.messageId, preview: replyTo.preview, senderName: replyTo.senderName } : null,
      expiresIn: expiresIn || undefined,
      clientMessageId,
    });

    if (result?.queued) {
      // Offline — keep optimistic bubble, show queued status
      setDeliveryStatus((prev) => ({ ...prev, [clientMessageId]: "queued" }));
    } else if (!result?.ok && !result?.queued) {
      if (result?.error === "rate_limited") {
        makeToast("error", "Slow down — you're sending too fast");
        // Remove the optimistic bubble
        setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
        setDeliveryStatus((prev) => { const n = { ...prev }; delete n[clientMessageId]; return n; });
      }
    }
  }, [newMessage, socket, chatroomId, replyTo, expiresIn, userId, user, sendWithGuarantee, scrollToBottom]);

  const sendFile = (fileData) => {
    if (!socket) return;
    socket.emit("chatroomFileMessage", { chatroomId, ...fileData, replyTo });
    setReplyTo(null);
  };

  const sendLocation = ({ lat, lng }) => {
    if (!socket) return;
    socket.emit("chatroomFileMessage", { chatroomId, type: "location", lat, lng, message: "📍 Location", replyTo });
    setReplyTo(null);
  };

  const handleTyping = () => {
    if (!socket) return;
    socket.emit("typing", { chatroomId });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => socket.emit("stopTyping", { chatroomId }), 2000);
  };

  const handleSaveEdit = async (messageId, newText) => {
    try {
      await api.put(`/chatroom/messages/${messageId}`, { message: newText });
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, message: newText, edited: true } : m));
      socket?.emit("messageEdited", { chatroomId, messageId, newText });
      setEditingId(null);
      makeToast("success", "Message updated");
    } catch (err) {
      makeToast("error", err?.response?.data?.message || "Failed to edit");
    }
  };

  const handleConfirmDelete = async (messageId) => {
    try {
      await api.delete(`/chatroom/messages/${messageId}`);
      setMessages((prev) => prev.filter((m) => m._id !== messageId));
      socket?.emit("messageDeleted", { chatroomId, messageId });
      setDeleteTarget(null);
      makeToast("success", "Message deleted");
    } catch (err) {
      makeToast("error", err?.response?.data?.message || "Failed to delete");
    }
  };

  const handleReact = async (messageId, emoji) => {
    try {
      const res = await api.post(`/chatroom/messages/${messageId}/react`, { emoji });
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, reactions: res.data.reactions } : m));
      socket?.emit("reactionToggled", { chatroomId, messageId, reactions: res.data.reactions });
    } catch {}
  };

  const handlePin = async (messageId) => {
    try {
      const res = await api.post(`/chatroom/messages/${messageId}/pin`);
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, pinned: res.data.pinned } : m));
      socket?.emit("messagePinned", { chatroomId, messageId, pinned: res.data.pinned });
      loadPinned();
      makeToast("success", res.data.pinned ? "Message pinned" : "Message unpinned");
    } catch {}
  };

  const displayedMessages = searchResults !== null ? searchResults : messages;

  return (
    <div className="flex h-[calc(100vh-72px)]" style={{ background: "linear-gradient(135deg, #0f0f1a 0%, #1a1030 40%, #0d1a2e 100%)" }}>
      {/* Online users sidebar */}
      <aside
        className={`${showSidebar ? "translate-x-0" : "-translate-x-full md:translate-x-0"} fixed md:relative z-30 w-64 h-full border-r border-gray-700/50 flex flex-col transition-transform duration-300 bg-gray-900/80 backdrop-blur-sm`}
      >
        <OnlineUsersSidebar onlineUsers={onlineUsers} currentUserId={userId} />
      </aside>

      {showSidebar && (
        <div className="fixed inset-0 bg-black/50 z-20 md:hidden" onClick={() => setShowSidebar(false)} />
      )}

      {/* Main chat */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="bg-gray-900/90 backdrop-blur-sm border-b border-gray-700/50 px-4 py-3 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <Link to="/dashboard" className="p-2 hover:bg-gray-700 rounded-xl transition-colors" aria-label="Back">
              <ArrowLeftIcon className="w-5 h-5 text-gray-400" />
            </Link>
            <div>
              <h1 className="text-base font-semibold text-white flex items-center gap-1.5">
                {chatroomName}
                <LockClosedIcon className="w-3.5 h-3.5 text-violet-400" title="End-to-end encrypted" />
              </h1>
              <p className="text-xs text-gray-500">
                {onlineUsers.length} online · end-to-end encrypted
                {pendingCount > 0 && (
                  <span className="text-yellow-400 ml-2">· {pendingCount} sending…</span>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {showSearch ? (
              <MessageSearchBar onSearch={handleSearch} onClose={() => { setShowSearch(false); setSearchResults(null); setSearchQuery(""); }} />
            ) : (
              <button onClick={() => setShowSearch(true)} className="p-2 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-white transition-colors">
                <MagnifyingGlassIcon className="w-5 h-5" />
              </button>
            )}
            <button
              onClick={() => setShowAI((v) => !v)}
              className={`p-2 hover:bg-gray-700 rounded-xl transition-colors ${showAI ? "text-violet-400 bg-violet-500/10" : "text-gray-400"}`}
              title="AI Co-Pilot"
            >
              <SparklesIcon className="w-5 h-5" />
            </button>
            <button className="md:hidden p-2 hover:bg-gray-700 rounded-xl" onClick={() => setShowSidebar(!showSidebar)}>
              <UsersIcon className="w-5 h-5 text-gray-400" />
            </button>
            <div className="hidden sm:flex items-center gap-1.5 px-2">
              {isConnected ? (
                <>
                  <SignalIcon className="w-4 h-4 text-green-400" />
                  <span className="text-xs text-gray-400">Connected</span>
                </>
              ) : (
                <>
                  <SignalSlashIcon className="w-4 h-4 text-red-400 animate-pulse" />
                  <span className="text-xs text-red-400">Offline — messages queued</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Pinned messages banner */}
        <PinnedMessages messages={pinnedMessages} onUnpin={handlePin} />

        {/* Messages area */}
        <div
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-1 relative"
          onScroll={handleScroll}
          style={{
            backgroundImage: `radial-gradient(ellipse at 20% 50%, rgba(120,60,200,0.04) 0%, transparent 60%),
              radial-gradient(ellipse at 80% 20%, rgba(60,100,200,0.04) 0%, transparent 60%)`,
          }}
        >
          {page < totalPages && !isLoadingMessages && (
            <div className="flex justify-center mb-4">
              <button
                onClick={handleLoadMore}
                disabled={isLoadingMore}
                className="flex items-center gap-2 px-4 py-2 text-xs text-gray-400 hover:text-white bg-gray-800/60 hover:bg-gray-700 border border-gray-700/50 rounded-full transition-all disabled:opacity-50"
              >
                <ChevronUpIcon className="w-3.5 h-3.5" />
                {isLoadingMore ? "Loading…" : "Load older messages"}
              </button>
            </div>
          )}

          {searchResults !== null && (
            <div className="text-center mb-3">
              <span className="text-xs text-gray-500 bg-gray-800/60 px-3 py-1 rounded-full">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{searchQuery}"
              </span>
            </div>
          )}

          <MessageList
            messages={displayedMessages}
            isLoading={isLoadingMessages}
            currentUserId={userId}
            editingId={editingId}
            onStartEdit={(id) => setEditingId(id)}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={() => setEditingId(null)}
            onDeleteRequest={(msg) => setDeleteTarget(msg)}
            onReply={(msg) => setReplyTo({ messageId: msg._id, preview: msg.message?.slice(0, 80) || "File", senderName: msg.name })}
            onPin={handlePin}
            onReact={handleReact}
            messagesEndRef={messagesEndRef}
            typingUsers={typingUsers}
            searchQuery={searchQuery}
            deliveryStatus={deliveryStatus}
          />

          <ScrollToBottomFAB visible={showFAB} unread={unreadCount} onClick={() => scrollToBottom()} />
        </div>

        {/* Message input */}
        <MessageInput
          value={newMessage}
          onChange={(e) => setNewMessage(e.target.value)}
          onSubmit={sendMessage}
          onTyping={handleTyping}
          onSendFile={sendFile}
          onSendVoice={sendFile}
          onSendLocation={sendLocation}
          disabled={false}
          inputRef={inputRef}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          expiresIn={expiresIn}
          onExpiresInChange={setExpiresIn}
          onOpenAI={() => setShowAI((v) => !v)}
        />
      </div>

      <AICoPilot
        chatroomId={chatroomId}
        isOpen={showAI}
        onClose={() => setShowAI(false)}
        onSelectSuggestion={(text) => setNewMessage(text)}
      />

      {deleteTarget && (
        <MessageDelete
          messageId={deleteTarget._id}
          messagePreview={deleteTarget.message?.slice(0, 80)}
          onDelete={handleConfirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
};

export default ChatroomPage;
