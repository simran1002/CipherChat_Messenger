import { useSocket } from "../contexts/SocketContext";
import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import {
  ArrowLeftIcon,
  UsersIcon,
  UserGroupIcon,
  MagnifyingGlassIcon,
  LockClosedIcon,
  SparklesIcon,
  SignalIcon,
  SignalSlashIcon,
} from "@heroicons/react/24/outline";
import { makeToast } from "../utils/toast";
import api from "../services/api";
import notificationService from "../services/NotificationService";
import * as heartbeatSvc from "../services/HeartbeatService";
import { drain as drainOfflineQueue } from "../services/OfflineQueue";
import { useMessageDelivery } from "../hooks/useMessageDelivery";
import { getCurrentUserId } from "../hooks/useCurrentUser";
import MessageList, { type MessageListHandle, type ScrollMeta } from "../components/MessageList";
import MessageInput from "../components/MessageInput";
import MessageDelete from "../components/MessageDelete";
import OnlineUsersSidebar from "../components/OnlineUsersSidebar";
import PinnedMessages from "../components/PinnedMessages";
import MessageSearchBar from "../components/MessageSearchBar";
import ScrollToBottomFAB from "../components/ScrollToBottomFAB";
import AICoPilot from "../components/AICoPilot";
import RoomMembersPanel from "../components/RoomMembersPanel";
import type {
  AuthUser,
  ChatMessage,
  ChatroomFileMessagePayload,
  DeliveryState,
  NewMessagePayload,
  OnlineUserPublic,
  ReactionEntry,
  ReplyToRef,
} from "../types";

const MESSAGES_PER_PAGE = 50;

interface ChatroomPageProps {
  user: AuthUser | null;
}

interface TypingUser {
  userId: string;
  name: string;
}

/** Raw REST row from GET /chatroom/:id/messages — user is nested, not flattened. */
interface RawChatroomMessage {
  _id: string;
  type?: string;
  message?: string;
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  lat?: number | null;
  lng?: number | null;
  edited?: boolean;
  reactions?: ReactionEntry[];
  replyTo?: ReplyToRef | null;
  pinned?: boolean;
  sequenceNumber?: number;
  readBy?: Array<{ user: string; readAt?: string }>;
  deliveredTo?: string[];
  user?: { _id?: string; name?: string; dp?: string } | null;
  createdAt: string;
}

/** Cursor block returned by GET /chatroom/:id/messages. */
interface MessagesCursor {
  nextCursor: string | null;
  hasMore: boolean;
}

const mapRawMessage = (m: RawChatroomMessage): ChatMessage => ({
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
  userId: m.user?._id as string,
  dp: m.user?.dp || "",
  createdAt: m.createdAt,
});

const ChatroomPage = ({ user }: ChatroomPageProps) => {
  const { socket } = useSocket();
  // Route guarantees the param (/chatroom/:chatroomId)
  const chatroomId = useParams().chatroomId as string;
  const navigate = useNavigate();

  // Core state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [userId, setUserId] = useState("");
  const [chatroomName, setChatroomName] = useState("Loading…");
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUserPublic[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(true);
  const [isConnected, setIsConnected] = useState(true);

  // UI state
  const [showSidebar, setShowSidebar] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ChatMessage | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyToRef | null>(null);
  const [mentions, setMentions] = useState<string[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<ChatMessage[]>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ChatMessage[] | null>(null);
  const [showFAB, setShowFAB] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [expiresIn, setExpiresIn] = useState<number | null>(null);
  const [showAI, setShowAI] = useState(false);

  // Cursor pagination (infinite scroll up): no params = newest 50, ascending.
  const [isLoadingMore, setIsLoadingMore] = useState(false);

  // Delivery tracking: clientMessageId → 'sending' | 'sent' | 'delivered' | 'read'
  const [deliveryStatus, setDeliveryStatus] = useState<Record<string, DeliveryState>>({});

  const listRef = useRef<MessageListHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isFirstLoad = useRef(true);
  const isAtBottomRef = useRef(true);
  const latestSeqRef = useRef(0); // tracks highest sequenceNumber seen
  const loadingMoreRef = useRef(false); // sync guard — state updates are async
  const cursorRef = useRef<{ nextCursor: string | null; hasMore: boolean }>({ nextCursor: null, hasMore: false });

  // Delivery hook — ACK + retry + offline queue fallback
  const { send: sendWithGuarantee, pendingCount } = useMessageDelivery(socket, chatroomId);

  // Decode userId from JWT
  useEffect(() => {
    const id = getCurrentUserId();
    if (id) setUserId(id);
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
    listRef.current?.scrollToBottom(smooth);
    setUnreadCount(0);
  }, []);

  const applyCursor = (cursor?: MessagesCursor | null) => {
    const next = cursor?.nextCursor ?? null;
    const more = Boolean(cursor?.hasMore && next);
    // Ref (not state): read synchronously inside scroll callbacks so a burst
    // of scroll events can't race a stale-closure hasMore/nextCursor.
    cursorRef.current = { nextCursor: next, hasMore: more };
  };

  /** Initial load: newest MESSAGES_PER_PAGE messages, ascending. */
  const loadInitial = useCallback(async () => {
    try {
      setIsLoadingMessages(true);
      const response = await api.get(`/chatroom/${chatroomId}/messages`, {
        params: { limit: MESSAGES_PER_PAGE },
      });
      const { messages: msgs, chatroom, cursor } = response.data as {
        messages: RawChatroomMessage[];
        chatroom: { name: string };
        cursor: MessagesCursor;
      };
      setChatroomName(chatroom.name);
      applyCursor(cursor);

      const mapped = msgs.map(mapRawMessage);
      setMessages(mapped);

      // Track latest sequence for read receipt emission
      if (mapped.length > 0) {
        const maxSeq = Math.max(...mapped.map((m) => m.sequenceNumber || 0));
        if (maxSeq > latestSeqRef.current) latestSeqRef.current = maxSeq;
      }
    } catch {
      makeToast("error", "Failed to load messages");
    } finally {
      setIsLoadingMessages(false);
    }
  }, [chatroomId]);

  /**
   * Infinite scroll up: fetch the page before the stored cursor and PREPEND it.
   *
   * Scroll-position preservation lives inside MessageList (which owns the
   * virtualizer): on a prepend it shifts scrollTop by the growth in
   * virtualizer.getTotalSize() (item keys are stable, so only rows inserted
   * above the old first message account for the difference), and
   * shouldAdjustScrollPositionOnItemSizeChange compensates for later
   * estimate→real measurement corrections above the viewport. Net effect:
   * the message the user was looking at never moves.
   */
  const loadOlder = useCallback(async () => {
    const { nextCursor: cur, hasMore: more } = cursorRef.current;
    if (!more || !cur || loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const response = await api.get(`/chatroom/${chatroomId}/messages`, {
        params: { before: cur, limit: MESSAGES_PER_PAGE },
      });
      const { messages: msgs, cursor } = response.data as {
        messages: RawChatroomMessage[];
        cursor: MessagesCursor;
      };
      applyCursor(cursor);
      const mapped = msgs.map(mapRawMessage);
      if (mapped.length > 0) {
        setMessages((prev) => [...mapped, ...prev]);
      }
    } catch {
      makeToast("error", "Failed to load older messages");
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [chatroomId]);

  const loadPinned = useCallback(async () => {
    try {
      const res = await api.get(`/chatroom/${chatroomId}/pinned`);
      setPinnedMessages(res.data as ChatMessage[]);
    } catch {}
  }, [chatroomId]);

  useEffect(() => {
    loadInitial();
    loadPinned();
  }, [loadInitial, loadPinned]);

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

  // Scroll meta from MessageList (which owns the scrollable element now):
  // atBottom drives markRead + FAB exactly as the old onScroll handler did;
  // nearTop triggers infinite-scroll-up pagination.
  const handleScrollMeta = useCallback(({ atBottom, nearTop }: ScrollMeta) => {
    isAtBottomRef.current = atBottom;
    setShowFAB(!atBottom);
    if (atBottom) {
      setUnreadCount(0);
      // Emit read receipt for all visible messages when scrolled to bottom
      if (socket?.connected && latestSeqRef.current > 0) {
        socket.emit("markRead", { chatroomId, upToSequence: latestSeqRef.current });
      }
    }
    if (nearTop && searchResults === null && !isLoadingMessages) {
      loadOlder();
    }
  }, [socket, chatroomId, searchResults, isLoadingMessages, loadOlder]);

  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (!q) { setSearchResults(null); return; }
    try {
      const res = await api.get(`/chatroom/${chatroomId}/messages/search`, { params: { q } });
      const rows = res.data.messages as RawChatroomMessage[];
      const mapped: ChatMessage[] = rows.map((m) => ({
        _id: m._id, type: m.type || "text", message: m.message || "",
        fileUrl: m.fileUrl, fileName: m.fileName, mimeType: m.mimeType,
        lat: m.lat, lng: m.lng, edited: m.edited, reactions: m.reactions || [],
        replyTo: m.replyTo, name: m.user?.name || "?", userId: m.user?._id as string,
        dp: m.user?.dp || "", createdAt: m.createdAt,
      }));
      setSearchResults(mapped);
    } catch { makeToast("error", "Search failed"); }
  };

  // Socket events
  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (msg: NewMessagePayload) => {
      const mapped: ChatMessage = {
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

      const cmid = msg.clientMessageId;
      setMessages((prev) => {
        // Idempotency: the ack path or a re-registered handler may deliver the
        // same echo twice — never append a message _id we already hold.
        if (prev.some((m) => m._id === mapped._id && !m._pending)) return prev;
        // If a pending optimistic message exists with same clientMessageId
        // (or the ack already stamped the real _id), replace it in place.
        const idx = prev.findIndex(
          (m) => (cmid && m.clientMessageId === cmid) || m._id === mapped._id
        );
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = mapped;
          return next;
        }
        return [...prev, mapped];
      });

      // Update delivery status
      if (cmid) {
        setDeliveryStatus((prev) => ({ ...prev, [cmid]: "sent" }));
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

    const handleDeliveryUpdate = ({ messageId, deliveredTo }: { messageId: string; deliveredTo: string[] }) => {
      setMessages((prev) =>
        prev.map((m) => m._id === messageId ? { ...m, deliveredTo } : m)
      );
    };

    const handleMessagesRead = ({ userId: readerId, upToSequence }: {
      userId: string;
      chatroomId: string;
      upToSequence: number | null;
      readAt: string;
    }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (
            upToSequence == null || (m.sequenceNumber != null && m.sequenceNumber <= upToSequence)
          ) {
            // Server may send readBy.user as an id string or a populated object
            const alreadyRead = m.readBy?.some((r) => {
              const u = r.user as string | { _id?: string } | null | undefined;
              return u === readerId || (typeof u === "object" ? u?._id === readerId : false);
            });
            if (!alreadyRead) {
              return { ...m, readBy: [...(m.readBy || []), { user: readerId, readAt: new Date().toISOString() }] };
            }
          }
          return m;
        })
      );
    };

    const handleUserTyping = (data: { userId: string; name: string; chatroomId: string }) => {
      if (data.chatroomId !== chatroomId || data.userId === userId) return;
      setTypingUsers((prev) => {
        if (prev.find((u) => u.userId === data.userId)) return prev;
        return [...prev, { userId: data.userId, name: data.name }];
      });
    };

    const handleStopTyping = (data: { userId: string; chatroomId: string }) => {
      if (data.chatroomId === chatroomId) {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== data.userId));
      }
    };

    const handleEdited = ({ messageId, newText }: { messageId: string; newText: string }) => {
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, message: newText, edited: true } : m));
    };

    const handleDeleted = ({ messageId }: { messageId: string }) => {
      setMessages((prev) => prev.filter((m) => m._id !== messageId));
    };

    const handleReactionUpdated = ({ messageId, reactions }: { messageId: string; reactions: ReactionEntry[] }) => {
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, reactions } : m));
    };

    const handlePinned = ({ messageId, pinned }: { messageId: string; pinned: boolean }) => {
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
    return () => { socket.emit("leaveRoom", { chatroomId }); };
  }, [socket, chatroomId]);

  // Send text message — uses delivery hook (ACK + retry + offline queue)
  const sendMessage = useCallback(async (e?: FormEvent) => {
    e?.preventDefault();
    const text = newMessage.trim();
    if (!text) return;

    const clientMessageId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const msgMentions = mentions;

    // Optimistic UI — add a pending bubble immediately
    const optimistic: ChatMessage = {
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
    setMentions([]); // reset composer mentions after send
    if (typingTimeoutRef.current) { clearTimeout(typingTimeoutRef.current); }
    socket?.emit("stopTyping", { chatroomId });
    setTimeout(() => scrollToBottom(), 50);
    inputRef.current?.focus();

    const result = await sendWithGuarantee({
      message: text,
      replyTo: replyTo ? { messageId: replyTo.messageId, preview: replyTo.preview, senderName: replyTo.senderName } : undefined,
      expiresIn: expiresIn || undefined,
      clientMessageId,
      ...(msgMentions.length > 0 ? { mentions: msgMentions } : {}),
    });

    if ("queued" in result && result.queued) {
      // Offline — keep optimistic bubble, show queued status
      setDeliveryStatus((prev) => ({ ...prev, [clientMessageId]: "queued" }));
    } else if ("error" in result && !result.ok) {
      if (result.error === "rate_limited") {
        makeToast("error", "Slow down — you're sending too fast");
        // Remove the optimistic bubble
        setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
        setDeliveryStatus((prev) => { const n = { ...prev }; delete n[clientMessageId]; return n; });
      }
    }
  }, [newMessage, socket, chatroomId, replyTo, expiresIn, mentions, userId, user, sendWithGuarantee, scrollToBottom]);

  const sendFile = (fileData: Omit<ChatroomFileMessagePayload, "chatroomId" | "replyTo">) => {
    if (!socket) return;
    socket.emit("chatroomFileMessage", { chatroomId, ...fileData, replyTo: replyTo ?? undefined });
    setReplyTo(null);
  };

  const sendLocation = ({ lat, lng }: { lat: number; lng: number }) => {
    if (!socket) return;
    // NOTE: `message` is not part of ChatroomFileMessagePayload but the server accepts it — cast keeps runtime behavior.
    socket.emit("chatroomFileMessage", {
      chatroomId,
      type: "location",
      lat,
      lng,
      message: "📍 Location",
      replyTo: replyTo ?? undefined,
    } as ChatroomFileMessagePayload);
    setReplyTo(null);
  };

  const handleTyping = () => {
    if (!socket) return;
    socket.emit("typing", { chatroomId });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => socket.emit("stopTyping", { chatroomId }), 2000);
  };

  const handleSaveEdit = async (messageId: string, newText: string) => {
    try {
      await api.put(`/chatroom/messages/${messageId}`, { message: newText });
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, message: newText, edited: true } : m));
      socket?.emit("messageEdited", { chatroomId, messageId, newText });
      setEditingId(null);
      makeToast("success", "Message updated");
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      makeToast("error", message || "Failed to edit");
    }
  };

  const handleConfirmDelete = async (messageId: string) => {
    try {
      await api.delete(`/chatroom/messages/${messageId}`);
      setMessages((prev) => prev.filter((m) => m._id !== messageId));
      socket?.emit("messageDeleted", { chatroomId, messageId });
      setDeleteTarget(null);
      makeToast("success", "Message deleted");
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      makeToast("error", message || "Failed to delete");
    }
  };

  const handleReact = async (messageId: string, emoji: string) => {
    try {
      const res = await api.post(`/chatroom/messages/${messageId}/react`, { emoji });
      const reactions = res.data.reactions as ReactionEntry[];
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, reactions } : m));
      socket?.emit("reactionToggled", { chatroomId, messageId, reactions });
    } catch {}
  };

  const handlePin = async (messageId: string) => {
    try {
      const res = await api.post(`/chatroom/messages/${messageId}/pin`);
      const pinned = res.data.pinned as boolean;
      setMessages((prev) => prev.map((m) => m._id === messageId ? { ...m, pinned } : m));
      socket?.emit("messagePinned", { chatroomId, messageId, pinned });
      loadPinned();
      makeToast("success", pinned ? "Message pinned" : "Message unpinned");
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
              onClick={() => setShowMembers(true)}
              className="p-2 hover:bg-gray-700 rounded-xl text-gray-400 hover:text-white transition-colors"
              title="Room members"
              aria-label="Room members"
            >
              <UserGroupIcon className="w-5 h-5" />
            </button>
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

        {/* Messages area — MessageList owns the scrollable element (virtualized) */}
        <div
          className="flex-1 relative min-h-0"
          style={{
            backgroundImage: `radial-gradient(ellipse at 20% 50%, rgba(120,60,200,0.04) 0%, transparent 60%),
              radial-gradient(ellipse at 80% 20%, rgba(60,100,200,0.04) 0%, transparent 60%)`,
          }}
        >
          {/* Overlay (not in scroll flow, so it never shifts virtual rows) */}
          {isLoadingMore && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10">
              <span className="text-xs text-gray-400 bg-gray-800/80 border border-gray-700/50 px-3 py-1 rounded-full">
                Loading older messages…
              </span>
            </div>
          )}

          {searchResults !== null && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10">
              <span className="text-xs text-gray-500 bg-gray-800/80 px-3 py-1 rounded-full border border-gray-700/50">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""} for "{searchQuery}"
              </span>
            </div>
          )}

          <MessageList
            ref={listRef}
            className="h-full overflow-y-auto px-4 sm:px-6 py-4"
            messages={displayedMessages}
            isLoading={isLoadingMessages}
            currentUserId={userId}
            editingId={editingId}
            onStartEdit={(id: string) => setEditingId(id)}
            onSaveEdit={handleSaveEdit}
            onCancelEdit={() => setEditingId(null)}
            onDeleteRequest={(msg: ChatMessage) => setDeleteTarget(msg)}
            onReply={(msg: ChatMessage) => setReplyTo({ messageId: msg._id, preview: msg.message?.slice(0, 80) || "File", senderName: msg.name })}
            onPin={handlePin}
            onReact={handleReact}
            typingUsers={typingUsers}
            searchQuery={searchQuery}
            deliveryStatus={deliveryStatus}
            onScrollMeta={handleScrollMeta}
          />

          <ScrollToBottomFAB visible={showFAB} unread={unreadCount} onClick={() => scrollToBottom()} />
        </div>

        {/* Message input */}
        <MessageInput
          value={newMessage}
          onChange={(e: { target: { value: string } }) => setNewMessage(e.target.value)}
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
          chatroomId={chatroomId}
          onMentionsChange={setMentions}
        />
      </div>

      <AICoPilot
        chatroomId={chatroomId}
        isOpen={showAI}
        onClose={() => setShowAI(false)}
        onSelectSuggestion={(text: string) => setNewMessage(text)}
      />

      <RoomMembersPanel
        chatroomId={chatroomId}
        isOpen={showMembers}
        onClose={() => setShowMembers(false)}
        onLeft={() => navigate("/dashboard")}
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
