import { useState, useEffect, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  PlusIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  MagnifyingGlassIcon,
  ArrowRightIcon,
  UserCircleIcon,
} from "@heroicons/react/24/outline";
import { makeToast } from "../utils/toast";
import api from "../services/api";
import type { AppSocket, Chatroom } from "../types";

interface DashboardPageProps {
  socket: AppSocket | null;
}

// The socket prop is passed by App but not used on this page (kept for API parity).
// socket prop kept for call-site parity; the dashboard itself never uses it
const DashboardPage = ({}: DashboardPageProps) => {
  const [chatrooms, setChatrooms] = useState<Chatroom[]>([]);
  const [newChatroomName, setNewChatroomName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const getChatrooms = async () => {
    try {
      const response = await api.get("/chatroom");
      setChatrooms(response.data as Chatroom[]);
    } catch (err) {
      console.error("Error fetching chatrooms:", err);
      makeToast("error", "Failed to load chatrooms");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    getChatrooms();
  }, []);

  const createChatroom = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!newChatroomName.trim()) {
      makeToast("error", "Please enter a chatroom name");
      return;
    }

    setIsCreating(true);
    try {
      const response = await api.post("/chatroom", {
        name: newChatroomName.trim(),
      });
      makeToast("success", (response.data as { message: string }).message);
      setNewChatroomName("");
      setShowCreateForm(false);
      getChatrooms();
    } catch (err) {
      const message = (err as { response?: { data?: { message?: string } } })?.response?.data
        ?.message;
      makeToast("error", message || "Failed to create chatroom");
    } finally {
      setIsCreating(false);
    }
  };

  const filteredChatrooms = chatrooms.filter((chatroom) =>
    chatroom.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (dateString?: string) => {
    if (!dateString) return "";
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffInHours < 1) return "Just now";
    if (diffInHours < 24)
      return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (diffInHours < 48) return "Yesterday";
    return date.toLocaleDateString();
  };

  const chatroomColors = [
    "from-blue-500 to-cyan-500",
    "from-purple-500 to-pink-500",
    "from-green-500 to-emerald-500",
    "from-orange-500 to-red-500",
    "from-indigo-500 to-violet-500",
    "from-teal-500 to-cyan-500",
  ];

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-primary-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Loading chatrooms...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      <div className="bg-gray-800/50 backdrop-blur-sm border-b border-gray-700/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold text-white">Chatrooms</h1>
              <p className="text-gray-400 mt-1">
                {chatrooms.length} {chatrooms.length === 1 ? "room" : "rooms"} available
              </p>
            </div>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowCreateForm(true)}
              className="bg-gradient-to-r from-primary-500 to-secondary-500 hover:from-primary-600 hover:to-secondary-600 text-white font-medium px-5 py-2.5 rounded-xl flex items-center space-x-2 shadow-lg shadow-primary-500/25 transition-all"
            >
              <PlusIcon className="w-5 h-5" />
              <span>New Chatroom</span>
            </motion.button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
              <MagnifyingGlassIcon className="h-5 w-5 text-gray-500" />
            </div>
            <input
              type="text"
              placeholder="Search chatrooms..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-gray-800/50 border border-gray-700 text-white rounded-xl pl-12 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-500 transition-all"
            />
          </div>
        </div>

        <AnimatePresence>
          {showCreateForm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50"
              onClick={() => setShowCreateForm(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="bg-gray-800 border border-gray-700 rounded-2xl p-6 w-full max-w-md shadow-2xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-xl font-semibold text-white mb-4">
                  Create New Chatroom
                </h2>
                <form onSubmit={createChatroom} className="space-y-4">
                  <div>
                    <label htmlFor="chatroomName" className="block text-sm font-medium text-gray-300 mb-2">
                      Chatroom Name
                    </label>
                    <input
                      type="text"
                      id="chatroomName"
                      value={newChatroomName}
                      onChange={(e) => setNewChatroomName(e.target.value)}
                      className="w-full bg-gray-700/50 border border-gray-600 text-white rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-500 transition-all"
                      placeholder="Enter chatroom name"
                      maxLength={50}
                      required
                    />
                    <p className="text-xs text-gray-500 mt-1">
                      Letters, numbers, spaces, hyphens, and underscores only
                    </p>
                  </div>
                  <div className="flex space-x-3 pt-2">
                    <button
                      type="button"
                      onClick={() => setShowCreateForm(false)}
                      className="flex-1 py-2.5 rounded-xl border border-gray-600 text-gray-300 hover:text-white hover:border-gray-500 transition-all font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isCreating}
                      className="flex-1 bg-gradient-to-r from-primary-500 to-secondary-500 hover:from-primary-600 hover:to-secondary-600 text-white py-2.5 rounded-xl disabled:opacity-50 font-medium transition-all"
                    >
                      {isCreating ? "Creating..." : "Create"}
                    </button>
                  </div>
                </form>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {filteredChatrooms.length === 0 ? (
          <div className="text-center py-20">
            <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto mb-6">
              <ChatBubbleLeftRightIcon className="w-10 h-10 text-gray-600" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">
              {searchTerm ? "No chatrooms found" : "No chatrooms yet"}
            </h3>
            <p className="text-gray-400 mb-6">
              {searchTerm
                ? "Try adjusting your search terms"
                : "Be the first to create a chatroom!"}
            </p>
            {!searchTerm && (
              <button
                onClick={() => setShowCreateForm(true)}
                className="bg-gradient-to-r from-primary-500 to-secondary-500 text-white px-6 py-2.5 rounded-xl font-medium shadow-lg shadow-primary-500/25"
              >
                Create First Chatroom
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <AnimatePresence>
              {filteredChatrooms.map((chatroom, index) => (
                <motion.div
                  key={chatroom._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <Link
                    to={`/chatroom/${chatroom._id}`}
                    className="block bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-2xl p-6 hover:border-primary-500/50 hover:bg-gray-800/80 transition-all duration-300 group"
                  >
                    <div className="flex items-start justify-between mb-4">
                      <div
                        className={`w-12 h-12 rounded-xl bg-gradient-to-r ${chatroomColors[index % chatroomColors.length]} flex items-center justify-center shadow-lg`}
                      >
                        <span className="text-xl font-bold text-white">
                          {chatroom.name.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      <ArrowRightIcon className="w-5 h-5 text-gray-600 group-hover:text-primary-400 transition-colors" />
                    </div>
                    <h3 className="text-lg font-semibold text-white mb-2 group-hover:text-primary-400 transition-colors">
                      {chatroom.name}
                    </h3>
                    <div className="flex items-center gap-4 text-sm text-gray-500">
                      {chatroom.createdBy && (
                        <div className="flex items-center space-x-1">
                          <UserCircleIcon className="w-4 h-4" />
                          <span>{chatroom.createdBy.name || "Unknown"}</span>
                        </div>
                      )}
                      {chatroom.createdAt && (
                        <div className="flex items-center space-x-1">
                          <ClockIcon className="w-4 h-4" />
                          <span>{formatDate(chatroom.createdAt)}</span>
                        </div>
                      )}
                    </div>
                  </Link>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
};

export default DashboardPage;
