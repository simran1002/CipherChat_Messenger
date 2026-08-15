import React, { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  PencilIcon,
  TrashIcon,
  MapPinIcon,
  ArrowUturnLeftIcon,
  FaceSmileIcon,
} from "@heroicons/react/24/outline";
import { MapPinIcon as MapPinSolid } from "@heroicons/react/24/solid";
import MessageEdit from "./MessageEdit";
import ReactionPicker from "./ReactionPicker";
import { stringToColor, getInitials, formatTime, formatDateDivider } from "../utils/helpers";
import { getApiUrl } from "../services/api";
import TranslateButton from "./TranslateButton";
import type { ChatMessage, DeliveryState, ReactionEntry, ReplyToRef } from "../types";

interface AvatarProps {
  name: string;
  dp?: string;
  size?: string;
}

const Avatar = ({ name, dp, size = "w-8 h-8" }: AvatarProps) => {
  const src = dp ? (dp.startsWith("http") ? dp : `${getApiUrl()}${dp}`) : null;
  if (src) return <img src={src} alt={name} className={`${size} rounded-full object-cover shrink-0`} />;
  return (
    <div
      className={`${size} rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0`}
      style={{ background: stringToColor(name) }}
    >
      {getInitials(name)}
    </div>
  );
};

interface LocationBubbleProps {
  lat?: number | null;
  lng?: number | null;
}

const LocationBubble = ({ lat, lng }: LocationBubbleProps) => {
  const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}&zoom=14`;
  const imgUrl = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=14&size=280x140&markers=${lat},${lng},red-pushpin`;
  return (
    <a href={mapUrl} target="_blank" rel="noopener noreferrer" className="block rounded-xl overflow-hidden border border-white/20 hover:border-violet-300 transition-colors">
      <img src={imgUrl} alt="Location" className="w-56 h-28 object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-black/20">
        <MapPinSolid className="w-3.5 h-3.5 text-red-400" />
        <span className="text-xs">View on map</span>
      </div>
    </a>
  );
};

const FileBubble = ({ msg }: { msg: ChatMessage }) => {
  const apiBase = getApiUrl();
  const url = msg.fileUrl?.startsWith("http") ? msg.fileUrl : `${apiBase}${msg.fileUrl}`;

  if (msg.type === "image") {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        <img src={url} alt={msg.fileName || "Image"} className="max-w-xs rounded-xl hover:opacity-90 transition-opacity" />
      </a>
    );
  }
  if (msg.type === "audio") {
    return <audio src={url} controls className="max-w-xs h-10" />;
  }
  const sizeKb = msg.fileSize ? `${(msg.fileSize / 1024).toFixed(1)} KB` : "";
  return (
    <a href={url} download={msg.fileName} className="flex items-center gap-2 px-3 py-2 bg-black/20 rounded-xl hover:bg-black/30 transition-colors max-w-xs">
      <span className="text-2xl">📎</span>
      <div className="min-w-0">
        <p className="text-sm truncate">{msg.fileName}</p>
        {sizeKb && <p className="text-xs opacity-60">{sizeKb}</p>}
      </div>
    </a>
  );
};

interface ReactionsBarProps {
  reactions?: ReactionEntry[];
  onToggle: (emoji: string) => void;
}

const ReactionsBar = ({ reactions, onToggle }: ReactionsBarProps) => {
  if (!reactions || reactions.length === 0) return null;
  const grouped = reactions.reduce<Record<string, string[]>>((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = [];
    acc[r.emoji].push(r.name || "?");
    return acc;
  }, {});
  return (
    <div className="flex flex-wrap gap-1 mt-1">
      {Object.entries(grouped).map(([emoji, names]) => (
        <button
          key={emoji}
          onClick={() => onToggle(emoji)}
          title={names.join(", ")}
          className="flex items-center gap-0.5 px-1.5 py-0.5 bg-gray-700/70 hover:bg-gray-600 border border-gray-600 rounded-full text-xs transition-colors"
        >
          {emoji} <span className="text-gray-300">{names.length}</span>
        </button>
      ))}
    </div>
  );
};

const ReplyQuote = ({ replyTo }: { replyTo?: ReplyToRef | null }) => {
  if (!replyTo?.senderName) return null;
  return (
    <div className="flex items-start gap-2 border-l-2 border-white/40 pl-2 mb-1.5 opacity-75">
      <div>
        <span className="text-xs font-semibold opacity-90">{replyTo.senderName}</span>
        <p className="text-xs opacity-70 truncate max-w-xs">{replyTo.preview}</p>
      </div>
    </div>
  );
};

interface DeliveryTickProps {
  msg: ChatMessage;
  deliveryStatus?: Record<string, DeliveryState>;
}

// Delivery tick (WhatsApp-style) ─ only shown on own messages
const DeliveryTick = ({ msg, deliveryStatus }: DeliveryTickProps) => {
  const status = msg.clientMessageId ? deliveryStatus?.[msg.clientMessageId] : undefined;
  const hasReaders = msg.readBy && msg.readBy.length > 0;
  const hasDelivered = msg.deliveredTo && msg.deliveredTo.length > 1; // >1 because sender is always in array

  if (msg._pending || status === "sending") {
    return <span className="text-[10px] opacity-40" title="Sending…">◌</span>;
  }
  if (status === "queued") {
    return <span className="text-[10px] text-yellow-400/70" title="Queued — will send when online">⏳</span>;
  }
  if (hasReaders) {
    return <span className="text-[10px] text-blue-400" title="Read">✓✓</span>;
  }
  if (hasDelivered) {
    return <span className="text-[10px] opacity-70" title="Delivered">✓✓</span>;
  }
  return <span className="text-[10px] opacity-50" title="Sent">✓</span>;
};

interface MessageBubbleProps {
  msg: ChatMessage;
  isOwn: boolean;
  currentUserId?: string;
  onEdit: (messageId: string) => void;
  onDelete: (msg: ChatMessage) => void;
  onReply: (msg: ChatMessage) => void;
  onPin: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  searchQuery?: string;
  deliveryStatus?: Record<string, DeliveryState>;
}

const MessageBubble = ({ msg, isOwn, onEdit, onDelete, onReply, onPin, onReact, deliveryStatus }: MessageBubbleProps) => {
  const [showActions, setShowActions] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={`flex items-end gap-2 group ${isOwn ? "flex-row-reverse" : "flex-row"}`}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => { setShowActions(false); setShowReactionPicker(false); }}
    >
      {/* Avatar on received messages */}
      {!isOwn && <Avatar name={msg.name} dp={msg.dp} size="w-7 h-7" />}

      <div className={`relative max-w-[70%] flex flex-col ${isOwn ? "items-end" : "items-start"}`}>
        {!isOwn && <span className="text-xs text-gray-400 mb-0.5 ml-1">{msg.name}</span>}

        {/* Floating reaction picker */}
        <div className="relative">
          <ReactionPicker
            visible={showReactionPicker}
            onSelect={(emoji: string) => { onReact(msg._id, emoji); setShowReactionPicker(false); }}
          />
        </div>

        {/* Message bubble */}
        <div
          className={`relative px-4 py-2.5 shadow-sm
            ${isOwn
              ? "bg-gradient-to-br from-violet-600 to-purple-700 text-white rounded-2xl rounded-br-sm"
              : "bg-gray-700/80 text-gray-100 rounded-2xl rounded-bl-sm"
            }`}
        >
          <ReplyQuote replyTo={msg.replyTo} />

          {msg.type === "location" ? (
            <LocationBubble lat={msg.lat} lng={msg.lng} />
          ) : (msg.type === "image" || msg.type === "audio" || msg.type === "file") ? (
            <FileBubble msg={msg} />
          ) : (
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{msg.message}</p>
          )}

          <div className={`flex items-center gap-1.5 mt-1 ${isOwn ? "justify-end" : "justify-start"}`}>
            {msg.edited && <span className="text-[10px] opacity-60 italic">edited</span>}
            {msg.type === "text" && msg.message && (
              <TranslateButton text={msg.message} messageId={msg._id} />
            )}
            <span className="text-[10px] opacity-50">{formatTime(msg.createdAt)}</span>
            {isOwn && <DeliveryTick msg={msg} deliveryStatus={deliveryStatus} />}
          </div>
        </div>

        <ReactionsBar reactions={msg.reactions} onToggle={(emoji) => onReact(msg._id, emoji)} />
      </div>

      {/* Action buttons */}
      <AnimatePresence>
        {showActions && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            className={`flex items-center gap-0.5 self-center ${isOwn ? "flex-row-reverse" : "flex-row"}`}
          >
            <button onClick={() => onReply(msg)} title="Reply" className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-white transition-colors">
              <ArrowUturnLeftIcon className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => setShowReactionPicker((v) => !v)} title="React" className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-yellow-400 transition-colors">
              <FaceSmileIcon className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onPin(msg._id)} title="Pin" className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-violet-400 transition-colors">
              <MapPinIcon className="w-3.5 h-3.5" />
            </button>
            {isOwn && msg.type === "text" && (
              <button onClick={() => onEdit(msg._id)} title="Edit" className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-blue-400 transition-colors">
                <PencilIcon className="w-3.5 h-3.5" />
              </button>
            )}
            {isOwn && (
              <button onClick={() => onDelete(msg)} title="Delete" className="p-1.5 hover:bg-gray-700 rounded-lg text-gray-400 hover:text-red-400 transition-colors">
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

interface TypingUser {
  userId: string;
  name: string;
}

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  currentUserId: string;
  editingId: string | null;
  onStartEdit: (messageId: string) => void;
  onSaveEdit: (messageId: string, newText: string) => void | Promise<void>;
  onCancelEdit: () => void;
  onDeleteRequest: (msg: ChatMessage) => void;
  onReply: (msg: ChatMessage) => void;
  onPin: (messageId: string) => void;
  onReact: (messageId: string, emoji: string) => void;
  messagesEndRef: React.RefObject<HTMLDivElement>;
  typingUsers: TypingUser[];
  searchQuery?: string;
  deliveryStatus: Record<string, DeliveryState>;
}

const MessageList = ({
  messages,
  isLoading,
  currentUserId,
  editingId,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onDeleteRequest,
  onReply,
  onPin,
  onReact,
  messagesEndRef,
  typingUsers,
  searchQuery,
  deliveryStatus,
}: MessageListProps) => {
  if (isLoading) {
    return (
      <div className="flex flex-col gap-3 px-2">
        {[...Array(5)].map((_, i) => (
          <div key={i} className={`flex gap-3 ${i % 2 === 0 ? "" : "flex-row-reverse"}`}>
            <div className="w-8 h-8 bg-gray-700 rounded-full animate-pulse shrink-0" />
            <div className="h-12 bg-gray-700 rounded-2xl animate-pulse" style={{ width: `${40 + i * 10}%` }} />
          </div>
        ))}
      </div>
    );
  }

  let lastDate: string | null = null;

  return (
    <div className="flex flex-col gap-1">
      <AnimatePresence initial={false}>
        {messages.map((msg) => {
          const msgDate = formatDateDivider(msg.createdAt);
          const showDivider = msgDate !== lastDate;
          lastDate = msgDate;
          const isOwn = msg.userId === currentUserId;

          return (
            <React.Fragment key={msg._id}>
              {showDivider && (
                <div className="flex items-center gap-3 my-3">
                  <div className="flex-1 h-px bg-gray-700/50" />
                  <span className="text-xs text-gray-500 bg-gray-800/80 px-3 py-0.5 rounded-full border border-gray-700/50">
                    {msgDate}
                  </span>
                  <div className="flex-1 h-px bg-gray-700/50" />
                </div>
              )}

              {editingId === msg._id ? (
                <div className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
                  <MessageEdit messageId={msg._id} initialText={msg.message} onSave={onSaveEdit} onCancel={onCancelEdit} />
                </div>
              ) : (
                <MessageBubble
                  msg={msg}
                  isOwn={isOwn}
                  currentUserId={currentUserId}
                  onEdit={onStartEdit}
                  onDelete={onDeleteRequest}
                  onReply={onReply}
                  onPin={onPin}
                  onReact={onReact}
                  searchQuery={searchQuery}
                  deliveryStatus={deliveryStatus}
                />
              )}
            </React.Fragment>
          );
        })}
      </AnimatePresence>

      {/* Typing indicator */}
      {typingUsers && typingUsers.length > 0 && (
        <div className="flex items-end gap-2 py-1">
          <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center text-xs text-gray-300 font-bold">
            {typingUsers[0].name?.[0]?.toUpperCase()}
          </div>
          <div className="bg-gray-700/80 rounded-2xl rounded-bl-sm px-4 py-3 flex items-center gap-1">
            <span className="text-xs text-gray-400 mr-2">
              {typingUsers.length === 1
                ? `${typingUsers[0].name} is typing`
                : `${typingUsers[0].name} +${typingUsers.length - 1} are typing`}
            </span>
            {[0, 1, 2].map((i) => (
              <span key={i} className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  );
};

export default MessageList;
