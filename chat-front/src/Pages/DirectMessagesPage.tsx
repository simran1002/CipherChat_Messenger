import { useSocket } from "../contexts/SocketContext";
import React, { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  EnvelopeIcon,
  PlusIcon,
  PaperAirplaneIcon,
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  LockClosedIcon,
  PaperClipIcon,
  ShieldCheckIcon,
} from "@heroicons/react/24/outline";
import { makeToast } from "../utils/toast";
import api, { apiErrorMessage } from "../services/api";
import e2eeService from "../services/E2EEService";
import { useE2EE, isNoKeysError } from "../hooks/useE2EE";
import E2EESetupGate from "../components/E2EESetupGate";
import SafetyNumberModal from "../components/SafetyNumberModal";
import DmAttachment from "../components/DmAttachment";
import { encryptFileForDm } from "../crypto/fileCrypto";
import { uploadEncryptedBlob } from "../services/encryptedUpload";
import { parseDmContent, previewDmContent, serializeDmContent } from "../crypto/dmContent";
import { getCurrentUserId } from "../hooks/useCurrentUser";
import { stringToColor, getInitials, formatTime, formatDateDivider } from "../utils/helpers";
import type { AuthUser, DmConversation, DmMessage } from "../types";
import type {
  DirectMessagePayload,
  DmEnvelope,
  DmMessageAck,
  NewDirectMessagePayload,
} from "../types/socket";
// Type-only import: DmEnvelope (wire type, v: number) narrows to WireEnvelope (v: 1)
// for e2eeService.decrypt — same runtime shape, see the casts below.
import type { WireEnvelope } from "../crypto/envelope";

interface AvatarUser {
  name?: string;
  dp?: string;
}

/** Only the fields this page reads from a conversation (startNewDM builds a partial one). */
type ConversationLike = Pick<DmConversation, "_id" | "participant">;

/** Row from GET /api/v1/users (UserView — has email; the room-members directory does not). */
interface DmUser {
  id: string;
  name: string;
  email: string;
  dp?: string;
}

/** Raw conversation row from GET /api/v1/conversations (DmDtos.ConversationView). */
interface RawConversationView {
  id: string;
  participant: { id: string; name: string; dp?: string } | null;
  lastMessage: { message: string; encrypted?: boolean; createdAt: string } | null;
  lastMessageAt: string;
}

const mapRawConversation = (c: RawConversationView): DmConversation => ({
  _id: c.id,
  participant: c.participant
    ? { _id: c.participant.id, name: c.participant.name, dp: c.participant.dp }
    : null,
  lastMessage: c.lastMessage,
  lastMessageAt: c.lastMessageAt,
});

/** Raw row from GET /api/v1/conversations/:id/messages (pre-decrypt; DmDtos.MessageView). */
interface RawDmRow {
  id: string;
  type?: "e2ee/v1" | "plaintext-legacy";
  message?: string;
  envelope?: DmEnvelope;
  clientMessageId?: string | null;
  edited?: boolean;
  userId: string;
  user?: { id: string; name?: string; dp?: string } | null;
  createdAt: string;
}

interface TypingUser {
  userId: string;
  name?: string;
}

const ENCRYPTED_PLACEHOLDER = "🔒 Encrypted message";

const Avatar = ({ user, size = "w-10 h-10" }: { user: AvatarUser | null | undefined; size?: string }) => {
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

interface DirectMessagesPageProps {
  user: AuthUser | null;
}

// `user` prop kept for call-site parity (App passes it); the page reads identity from storage.
const DirectMessagesPage = ({}: DirectMessagesPageProps) => {
  const { socket } = useSocket();
  const [conversations, setConversations] = useState<DmConversation[]>([]);
  const [activeConv, setActiveConv] = useState<ConversationLike | null>(null);
  const [messages, setMessages] = useState<DmMessage[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [isLoadingConvs, setIsLoadingConvs] = useState(true);
  const [isLoadingMsgs, setIsLoadingMsgs] = useState(false);
  const [showNewDM, setShowNewDM] = useState(false);
  const [allUsers, setAllUsers] = useState<DmUser[]>([]);
  const [userSearch, setUserSearch] = useState("");
  const [typingUsers, setTypingUsers] = useState<TypingUser[]>([]);
  const [currentUserId, setCurrentUserId] = useState("");
  const [keyChangedConvs, setKeyChangedConvs] = useState<Set<string>>(new Set());
  const [showSafetyModal, setShowSafetyModal] = useState(false);
  /** File name currently being encrypted & uploaded (composer pending strip). */
  const [pendingUpload, setPendingUpload] = useState<string | null>(null);
  // Local search over DECRYPTED messages. The server can't provide this —
  // it only ever holds ciphertext — so search runs entirely on this device.
  const [showDmSearch, setShowDmSearch] = useState(false);
  const [dmSearch, setDmSearch] = useState("");

  const { status: e2eeStatus, refresh: refreshE2EE } = useE2EE();

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const id = getCurrentUserId();
    if (id) setCurrentUserId(id);
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      setIsLoadingConvs(true);
      const res = await api.get("/api/v1/conversations");
      const rows = (res.data as RawConversationView[]).map(mapRawConversation);
      // Substitute locally cached decrypted previews for "🔒 Encrypted message"
      const withPreviews = await Promise.all(
        rows.map(async (conv) => {
          if (!conv.lastMessage?.encrypted) return conv;
          try {
            const preview = await e2eeService.getPreview(conv._id);
            if (preview) {
              // Older caches may hold raw serialized content — normalize to a preview line
              const display = previewDmContent(parseDmContent(preview));
              return { ...conv, lastMessage: { ...conv.lastMessage, message: display } };
            }
          } catch {
            // keep the server placeholder
          }
          return conv;
        })
      );
      setConversations(withPreviews);
    } catch {
      makeToast("error", "Failed to load conversations");
    } finally {
      setIsLoadingConvs(false);
    }
  }, []);

  useEffect(() => { loadConversations(); }, [loadConversations]);

  /** Update a sidebar row's preview + bump its recency. */
  const updateConvPreview = useCallback(
    (conversationId: string, message: string, encrypted: boolean, createdAt: string) => {
      setConversations((prev) =>
        prev.map((c) =>
          c._id === conversationId
            ? { ...c, lastMessage: { message, encrypted, createdAt }, lastMessageAt: createdAt }
            : c
        )
      );
    },
    []
  );

  const openConversation = async (conv: ConversationLike) => {
    setActiveConv(conv);
    setMessages([]);
    setShowDmSearch(false);
    setDmSearch("");
    setIsLoadingMsgs(true);
    try {
      const res = await api.get(`/api/v1/conversations/${conv._id}/messages`);
      const rows = res.data.messages as RawDmRow[];
      const me = currentUserId || getCurrentUserId() || "";
      const normalized = await Promise.all(
        rows.map(async (row): Promise<DmMessage> => {
          const base = {
            _id: row.id,
            type: row.type,
            clientMessageId: row.clientMessageId,
            edited: row.edited,
            userId: row.userId,
            name: row.user?.name,
            dp: row.user?.dp,
            createdAt: row.createdAt,
          };
          if (row.type === "e2ee/v1" && row.envelope) {
            const result = await e2eeService.decrypt(conv._id, row.userId, row.envelope as WireEnvelope, {
              own: row.userId === me,
            });
            return {
              ...base,
              message: result.text,
              envelope: row.envelope,
              encrypted: true,
              undecryptable: !result.ok,
            };
          }
          return { ...base, message: row.message ?? "" };
        })
      );
      setMessages(normalized);
      const last = normalized[normalized.length - 1];
      if (last?.encrypted && !last.undecryptable) {
        void e2eeService.cachePreview(conv._id, previewDmContent(parseDmContent(last.message)));
      }
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
    setShowSafetyModal(false);
  };

  // Socket events for DMs
  useEffect(() => {
    if (!socket) return;

    const handleNewDM = (data: NewDirectMessagePayload) => {
      void (async () => {
        const me = currentUserId || getCurrentUserId() || "";
        const own = data.userId === me;
        let text = data.message ?? "";
        let encrypted = false;
        let undecryptable = false;

        if (data.type === "e2ee/v1" && data.envelope) {
          encrypted = true;
          const result = await e2eeService.decrypt(
            data.conversationId,
            data.userId,
            data.envelope as WireEnvelope,
            { own }
          );
          text = result.text;
          undecryptable = !result.ok;
          if (result.ok) {
            // This is the latest message in the conversation — cache its preview
            void e2eeService.cachePreview(
              data.conversationId,
              previewDmContent(parseDmContent(text))
            );
          }
          if (result.keyChanged && !own) {
            setKeyChangedConvs((prev) => {
              const next = new Set(prev);
              next.add(data.conversationId);
              return next;
            });
          }
        }

        const previewText =
          encrypted && undecryptable
            ? ENCRYPTED_PLACEHOLDER
            : previewDmContent(parseDmContent(text));
        updateConvPreview(data.conversationId, previewText, encrypted, data.createdAt);

        if (!activeConv || data.conversationId !== activeConv._id) return;

        const msg: DmMessage = {
          _id: data.id,
          type: data.type,
          message: text,
          envelope: data.envelope,
          clientMessageId: data.clientMessageId,
          encrypted,
          undecryptable,
          userId: data.userId,
          name: data.name,
          dp: data.dp,
          createdAt: data.createdAt,
        };
        setMessages((prev) => {
          // Idempotent: never append a duplicate _id
          if (prev.some((m) => m._id === data.id && !m._pending)) return prev;
          const pendingIdx = data.clientMessageId
            ? prev.findIndex((m) => m.clientMessageId === data.clientMessageId)
            : -1;
          if (pendingIdx >= 0) {
            const copy = [...prev];
            copy[pendingIdx] = msg;
            return copy;
          }
          return [...prev, msg];
        });
        setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
      })();
    };

    const handleDmTyping = (data: { userId: string; name?: string }) => {
      if (!activeConv) return;
      setTypingUsers((prev) => {
        if (prev.find((u) => u.userId === data.userId)) return prev;
        return [...prev, { userId: data.userId, name: data.name }];
      });
      setTimeout(() => {
        setTypingUsers((prev) => prev.filter((u) => u.userId !== data.userId));
      }, 3000);
    };

    const handleDmStopTyping = ({ userId }: { userId: string }) => {
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
  }, [socket, activeConv, currentUserId, updateConvPreview]);

  /** Emit with a 5s ack timeout; reconcile or drop the optimistic bubble. */
  const emitDirectMessage = (payload: DirectMessagePayload, clientMessageId: string) => {
    if (!socket) return;
    const onAck = (err: Error | null, ack?: DmMessageAck) => {
      if (err || !ack?.ok || !ack.messageId) {
        makeToast("error", "Message failed to send");
        setMessages((prev) => prev.filter((m) => !(m._pending && m.clientMessageId === clientMessageId)));
        return;
      }
      const messageId = ack.messageId;
      setMessages((prev) => {
        // newDirectMessage may have landed first and already carries the real _id
        if (prev.some((m) => m._id === messageId && !m._pending)) {
          return prev.filter((m) => !(m._pending && m.clientMessageId === clientMessageId));
        }
        return prev.map((m) =>
          m._pending && m.clientMessageId === clientMessageId
            ? { ...m, _id: messageId, _pending: undefined }
            : m
        );
      });
    };
    socket.timeout(5000).emit("directMessage", payload, onAck);
  };

  const sendMessage = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const text = newMessage.trim();
    if (!text || !socket || !activeConv) return;

    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
      socket.emit("dmStopTyping", { conversationId: activeConv._id });
    }
    setNewMessage("");
    inputRef.current?.focus();

    const conversationId = activeConv._id;
    const peerId = activeConv.participant?._id ?? "";
    const clientMessageId = crypto.randomUUID();
    // Plaintext only when E2EE is unavailable; a missing participant while
    // "ready" fails encryption loudly instead of silently downgrading.
    const useEncryption = e2eeStatus.state === "ready";

    const optimistic: DmMessage = {
      _id: `pending-${clientMessageId}`,
      type: useEncryption ? "e2ee/v1" : "plaintext-legacy",
      message: text,
      clientMessageId,
      encrypted: useEncryption,
      userId: currentUserId || getCurrentUserId() || "",
      createdAt: new Date().toISOString(),
      _pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    if (!useEncryption) {
      // E2EE unavailable — degrade to legacy plaintext send
      emitDirectMessage({ conversationId, clientMessageId, message: text }, clientMessageId);
      updateConvPreview(conversationId, text, false, optimistic.createdAt);
      return;
    }

    try {
      const envelope = await e2eeService.encrypt(conversationId, peerId, text);
      emitDirectMessage({ conversationId, clientMessageId, envelope }, clientMessageId);
      void e2eeService.cachePreview(conversationId, text);
      updateConvPreview(conversationId, text, true, optimistic.createdAt);
    } catch (err) {
      if (isNoKeysError(err)) {
        // Peer never published keys — fall back to legacy plaintext
        setMessages((prev) =>
          prev.map((m) =>
            m.clientMessageId === clientMessageId
              ? { ...m, type: "plaintext-legacy" as const, encrypted: false }
              : m
          )
        );
        makeToast("warning", "Sent unencrypted — recipient hasn't enabled encryption yet");
        emitDirectMessage({ conversationId, clientMessageId, message: text }, clientMessageId);
        updateConvPreview(conversationId, text, false, optimistic.createdAt);
      } else {
        makeToast("error", "Encryption failed");
        setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
      }
    }
  };

  /**
   * Encrypt a picked file, upload the opaque blob, then send the descriptor
   * through the exact same E2EE send path a text message uses (optimistic
   * bubble → emit with ack → replace/drop). Attachments are E2EE-only by
   * design: the descriptor carries the file key, so there is no plaintext
   * fallback — unlike text.
   */
  const sendFile = async (file: File) => {
    if (!socket || !activeConv) return;

    if (e2eeStatus.state !== "ready") {
      makeToast("error", "Attachments require encryption to be set up");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      makeToast("error", "File exceeds the 10 MB limit");
      return;
    }

    const conversationId = activeConv._id;
    const peerId = activeConv.participant?._id ?? "";
    setPendingUpload(file.name);

    let serialized: string;
    try {
      const { blob, descriptor } = await encryptFileForDm(file);
      // Presigned direct-to-bucket PUT when object storage is configured,
      // proxied POST /upload/encrypted otherwise — decided server-side.
      const url = await uploadEncryptedBlob(blob);
      serialized = serializeDmContent({ t: "file", file: { ...descriptor, url } });
    } catch {
      setPendingUpload(null);
      makeToast("error", "Failed to encrypt & upload attachment");
      return;
    }
    setPendingUpload(null);

    // Serialized descriptor JSON deliberately skips the typed-text length
    // guard (the composer's maxLength only applies to keyboard input).
    const clientMessageId = crypto.randomUUID();
    const optimistic: DmMessage = {
      _id: `pending-${clientMessageId}`,
      type: "e2ee/v1",
      message: serialized,
      clientMessageId,
      encrypted: true,
      userId: currentUserId || getCurrentUserId() || "",
      createdAt: new Date().toISOString(),
      _pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

    try {
      const envelope = await e2eeService.encrypt(conversationId, peerId, serialized);
      emitDirectMessage({ conversationId, clientMessageId, envelope }, clientMessageId);
      const preview = previewDmContent(parseDmContent(serialized));
      void e2eeService.cachePreview(conversationId, preview);
      updateConvPreview(conversationId, preview, true, optimistic.createdAt);
    } catch (err) {
      // No plaintext downgrade for attachments — fail loudly either way
      makeToast(
        "error",
        isNoKeysError(err)
          ? "Can't send attachments — recipient hasn't enabled encryption yet"
          : "Encryption failed"
      );
      setMessages((prev) => prev.filter((m) => m.clientMessageId !== clientMessageId));
    }
  };

  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (file) void sendFile(file);
  };

  const handleTyping = () => {
    if (!socket || !activeConv) return;
    const conversationId = activeConv._id;
    socket.emit("dmTyping", { conversationId });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      socket.emit("dmStopTyping", { conversationId });
    }, 2000);
  };

  const startNewDM = async (targetUser: DmUser) => {
    try {
      const res = await api.post("/api/v1/conversations", { targetUserId: targetUser.id });
      setShowNewDM(false);
      await loadConversations();
      const conv = mapRawConversation(res.data as RawConversationView);
      openConversation(conv);
    } catch (err) {
      makeToast("error", apiErrorMessage(err, "Failed to start conversation"));
    }
  };

  const loadAllUsers = async () => {
    try {
      const res = await api.get("/api/v1/users");
      setAllUsers(res.data as DmUser[]);
    } catch {
      makeToast("error", "Failed to load users");
    }
  };

  const filteredUsers = allUsers.filter((u) =>
    u.name.toLowerCase().includes(userSearch.toLowerCase()) ||
    u.email.toLowerCase().includes(userSearch.toLowerCase())
  );

  const shouldShowDateDivider = (index: number) => {
    if (index === 0) return true;
    return new Date(messages[index].createdAt).toDateString() !== new Date(messages[index - 1].createdAt).toDateString();
  };

  const e2eeReady = e2eeStatus.state === "ready";
  const allE2EE = messages.length > 0 && messages.every((m) => m.encrypted);

  // Searchable text of a message as THIS device sees it (decrypted): body
  // text, or the real file name that travelled inside the envelope.
  const searchableText = (msg: DmMessage): string => {
    const content = parseDmContent(msg.message);
    return content.t === "file" ? content.file.name : content.text;
  };
  const dmQuery = dmSearch.trim().toLowerCase();
  const isSearching = showDmSearch && dmQuery.length > 0;
  const visibleMessages = isSearching
    ? messages.filter((m) => searchableText(m).toLowerCase().includes(dmQuery))
    : messages;
  const keyChangedActive = !!activeConv && keyChangedConvs.has(activeConv._id);

  const dmUi = (
    <div className="flex flex-1 min-h-0 w-full bg-gray-900">
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
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-white truncate">{activeConv.participant?.name}</h2>
                {e2eeReady && (
                  <span className="flex items-center gap-1 text-[10px] font-medium text-green-400 bg-green-500/10 border border-green-500/30 rounded-full px-2 py-0.5 shrink-0">
                    <LockClosedIcon className="w-3 h-3" /> Encrypted
                  </span>
                )}
              </div>
              <p className="text-xs text-gray-500 truncate">{activeConv.participant?.email}</p>
            </div>
            <div className="ml-auto flex items-center gap-1">
              <button
                onClick={() => {
                  setShowDmSearch((v) => {
                    if (v) setDmSearch("");
                    return !v;
                  });
                }}
                className={`p-2 hover:bg-gray-700 rounded-lg transition-colors ${showDmSearch ? "bg-gray-700" : ""}`}
                aria-label="Search this conversation"
                title="Search this conversation (on-device — the server only stores ciphertext)"
              >
                <MagnifyingGlassIcon className="w-5 h-5 text-gray-400" />
              </button>
              {e2eeReady && activeConv.participant && (
                <button
                  onClick={() => setShowSafetyModal(true)}
                  className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
                  aria-label="View safety number"
                  title="View safety number"
                >
                  <ShieldCheckIcon className="w-5 h-5 text-gray-400" />
                </button>
              )}
            </div>
          </div>

          {/* On-device search: filters the DECRYPTED messages held in memory */}
          {showDmSearch && (
            <div className="bg-gray-800/60 border-b border-gray-700/50 px-4 py-2 shrink-0">
              <div className="relative">
                <MagnifyingGlassIcon className="w-4 h-4 text-gray-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  autoFocus
                  type="text"
                  value={dmSearch}
                  onChange={(e) => setDmSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setShowDmSearch(false);
                      setDmSearch("");
                    }
                  }}
                  placeholder="Search decrypted messages on this device…"
                  aria-label="Search this conversation"
                  className="w-full bg-gray-900/70 border border-gray-700 focus:border-primary-500 rounded-lg pl-9 pr-3 py-1.5 text-sm text-gray-200 outline-none"
                />
              </div>
              {isSearching && (
                <p className="text-[11px] text-gray-500 mt-1.5">
                  {visibleMessages.length} match{visibleMessages.length === 1 ? "" : "es"} in{" "}
                  {messages.length} decrypted messages — searched locally, the server only ever
                  sees ciphertext
                </p>
              )}
            </div>
          )}

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
                {allE2EE && (
                  <div className="flex items-center justify-center pb-2">
                    <p className="text-[11px] text-gray-500">
                      🔒 Messages in this conversation are end-to-end encrypted
                    </p>
                  </div>
                )}
                {isSearching && visibleMessages.length === 0 && (
                  <div className="flex items-center justify-center h-full text-center">
                    <p className="text-gray-500 text-sm">
                      No matches for &ldquo;{dmSearch.trim()}&rdquo; in this conversation
                    </p>
                  </div>
                )}
                {visibleMessages.map((msg, index) => {
                  const isMine = msg.userId === currentUserId;
                  const content = parseDmContent(msg.message);
                  // Dividers reason about ADJACENT history — meaningless over
                  // a filtered result list, so hide them while searching.
                  const showE2EEDivider =
                    !isSearching && index > 0 && !messages[index - 1].encrypted && !!msg.encrypted;
                  return (
                    <React.Fragment key={msg._id || index}>
                      {!isSearching && shouldShowDateDivider(index) && (
                        <div className="flex items-center justify-center my-4">
                          <div className="bg-gray-800 text-gray-400 text-xs px-3 py-1 rounded-full border border-gray-700">
                            {formatDateDivider(msg.createdAt)}
                          </div>
                        </div>
                      )}
                      {showE2EEDivider && (
                        <div className="flex items-center gap-3 my-4">
                          <div className="flex-1 h-px bg-gray-700/60" />
                          <span className="text-[11px] text-gray-500 shrink-0">
                            🔒 Messages below are end-to-end encrypted
                          </span>
                          <div className="flex-1 h-px bg-gray-700/60" />
                        </div>
                      )}
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={`flex ${isMine ? "justify-end" : "justify-start"} mb-2`}
                      >
                        <div className={`max-w-[70%] px-4 py-2.5 rounded-2xl text-sm ${msg._pending ? "opacity-60" : ""} ${isMine ? "bg-gradient-to-r from-primary-500 to-primary-600 text-white rounded-br-md" : "bg-gray-800 text-gray-100 border border-gray-700/50 rounded-bl-md"}`}>
                          {content.t === "file" ? (
                            <DmAttachment file={content.file} isMine={isMine} />
                          ) : (
                            <p className={`leading-relaxed ${msg.undecryptable ? "italic opacity-80" : ""}`}>{content.text}</p>
                          )}
                          <p className={`text-[10px] mt-1 ${isMine ? "text-primary-200" : "text-gray-500"} text-right`}>{formatTime(msg.createdAt)}</p>
                        </div>
                      </motion.div>
                    </React.Fragment>
                  );
                })}
                {!isSearching && typingUsers.length > 0 && (
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

          {/* Key-change warning */}
          {keyChangedActive && (
            <div className="bg-amber-500/10 border-t border-amber-500/30 px-4 py-2.5 flex items-center gap-3 shrink-0">
              <p className="text-xs text-amber-300 flex-1">
                ⚠ {activeConv.participant?.name ?? "This contact"}'s safety code changed. Verify
                before sending sensitive messages.
              </p>
              <button
                onClick={() => setShowSafetyModal(true)}
                className="text-xs font-medium text-amber-300 border border-amber-500/40 hover:bg-amber-500/20 rounded-lg px-3 py-1 transition-colors shrink-0"
              >
                Verify
              </button>
            </div>
          )}

          {/* Input */}
          <div className="bg-gray-800/80 backdrop-blur-sm border-t border-gray-700/50 p-3 sm:p-4 shrink-0">
            {pendingUpload && (
              <div className="flex items-center gap-2 mb-2 px-1 text-xs text-gray-400">
                <div className="w-3.5 h-3.5 border-2 border-primary-400 border-t-transparent rounded-full animate-spin shrink-0" />
                <span className="truncate">Encrypting &amp; uploading {pendingUpload}…</span>
              </div>
            )}
            <form onSubmit={sendMessage} className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFilePick}
                aria-hidden="true"
                tabIndex={-1}
              />
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={!socket || !!pendingUpload}
                className="p-3 bg-gray-700/50 hover:bg-gray-700 border border-gray-600 text-gray-400 hover:text-gray-200 rounded-xl disabled:opacity-30 transition-all"
                aria-label="Attach file"
                title="Attach an encrypted file"
              >
                <PaperClipIcon className="w-5 h-5" />
              </motion.button>
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
                      key={u.id}
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

      {/* Safety number modal */}
      {showSafetyModal && activeConv?.participant && (
        <SafetyNumberModal
          peerId={activeConv.participant._id}
          peerName={activeConv.participant.name}
          onClose={() => setShowSafetyModal(false)}
        />
      )}
    </div>
  );

  if (e2eeStatus.state === "loading") {
    return (
      <div className="flex h-[calc(100vh-72px)] bg-gray-900 items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (e2eeStatus.state === "needs-setup" || e2eeStatus.state === "needs-restore-or-reset") {
    return (
      <div className="flex h-[calc(100vh-72px)] bg-gray-900">
        <E2EESetupGate status={e2eeStatus.state} onReady={refreshE2EE} />
      </div>
    );
  }

  if (e2eeStatus.state === "unavailable") {
    return (
      <div className="flex flex-col h-[calc(100vh-72px)] bg-gray-900">
        <E2EESetupGate status="unavailable" reason={e2eeStatus.reason} onReady={refreshE2EE}>
          {dmUi}
        </E2EESetupGate>
      </div>
    );
  }

  return <div className="flex h-[calc(100vh-72px)] bg-gray-900">{dmUi}</div>;
};

export default DirectMessagesPage;
