import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { 
  PlusIcon,
  ChatBubbleLeftRightIcon,
  UsersIcon,
  ClockIcon,
  MagnifyingGlassIcon
} from "@heroicons/react/24/outline";
import makeToast from "../Toaster";
import axios from "axios";

const DashboardPage = ({ socket }) => {
  const [chatrooms, setChatrooms] = useState([]);
  const [newChatroomName, setNewChatroomName] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  const getChatrooms = async () => {
    try {
      const response = await axios.get(
        "https://cipherchat-messenger.onrender.com/chatroom",
        {
          headers: {
            Authorization: "Bearer " + localStorage.getItem("CC_Token"),
          },
        }
      );
      setChatrooms(response.data);
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

  const createChatroom = async (e) => {
    e.preventDefault();
    if (!newChatroomName.trim()) {
      makeToast("error", "Please enter a chatroom name");
      return;
    }

    setIsCreating(true);
    try {
      const response = await axios.post(
        "https://cipherchat-messenger.onrender.com/chatroom",
        {
          name: newChatroomName.trim(),
        },
        {
          headers: {
            Authorization: "Bearer " + localStorage.getItem("CC_Token"),
          },
        }
      );
      
      makeToast("success", response.data.message);
      setNewChatroomName("");
      setShowCreateForm(false);
      getChatrooms();
    } catch (err) {
      if (err?.response?.data?.message) {
        makeToast("error", err.response.data.message);
      } else {
        makeToast("error", "Failed to create chatroom");
      }
    } finally {
      setIsCreating(false);
    }
  };

  const filteredChatrooms = chatrooms.filter(chatroom =>
    chatroom.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = (now - date) / (1000 * 60 * 60);
    
    if (diffInHours < 24) {
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } else if (diffInHours < 48) {
      return 'Yesterday';
    } else {
      return date.toLocaleDateString();
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="loading-dots mx-auto mb-4">
            <div></div>
            <div></div>
            <div></div>
          </div>
          <p className="text-gray-600">Loading chatrooms...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Chatrooms</h1>
              <p className="text-gray-600 mt-1">
                Join existing conversations or create new ones
              </p>
            </div>
            <motion.button
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowCreateForm(true)}
              className="btn-primary flex items-center space-x-2"
            >
              <PlusIcon className="w-5 h-5" />
              <span>New Chatroom</span>
            </motion.button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Search Bar */}
        <div className="mb-8">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
            </div>
            <input
              type="text"
              placeholder="Search chatrooms..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="input-field pl-10"
            />
          </div>
        </div>

        {/* Create Chatroom Modal */}
        <AnimatePresence>
          {showCreateForm && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
              onClick={() => setShowCreateForm(false)}
            >
              <motion.div
                initial={{ scale: 0.9, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.9, opacity: 0 }}
                className="card p-6 w-full max-w-md"
                onClick={(e) => e.stopPropagation()}
              >
                <h2 className="text-xl font-semibold text-gray-900 mb-4">
                  Create New Chatroom
                </h2>
                <form onSubmit={createChatroom} className="space-y-4">
                  <div>
                    <label htmlFor="chatroomName" className="block text-sm font-medium text-gray-700 mb-2">
                      Chatroom Name
                    </label>
                    <input
                      type="text"
                      id="chatroomName"
                      value={newChatroomName}
                      onChange={(e) => setNewChatroomName(e.target.value)}
                      className="input-field"
                      placeholder="Enter chatroom name"
                      required
                    />
                  </div>
                  <div className="flex space-x-3">
                    <button
                      type="button"
                      onClick={() => setShowCreateForm(false)}
                      className="btn-outline flex-1"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isCreating}
                      className="btn-primary flex-1 disabled:opacity-50"
                    >
                      {isCreating ? "Creating..." : "Create"}
                    </button>
                  </div>
                </form>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Chatrooms Grid */}
        {filteredChatrooms.length === 0 ? (
          <div className="text-center py-12">
            <ChatBubbleLeftRightIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">
              {searchTerm ? "No chatrooms found" : "No chatrooms yet"}
            </h3>
            <p className="text-gray-600 mb-6">
              {searchTerm 
                ? "Try adjusting your search terms" 
                : "Be the first to create a chatroom!"
              }
            </p>
            {!searchTerm && (
              <button
                onClick={() => setShowCreateForm(true)}
                className="btn-primary"
              >
                Create First Chatroom
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <AnimatePresence>
              {filteredChatrooms.map((chatroom, index) => (
                <motion.div
                  key={chatroom._id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  transition={{ delay: index * 0.1 }}
                  className="card p-6 hover:shadow-lg transition-shadow duration-200"
                >
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex-1">
                      <h3 className="text-lg font-semibold text-gray-900 mb-1">
                        {chatroom.name}
                      </h3>
                      <div className="flex items-center text-sm text-gray-500 space-x-4">
                        <div className="flex items-center space-x-1">
                          <UsersIcon className="w-4 h-4" />
                          <span>{chatroom.users?.length || 0} members</span>
                        </div>
                        <div className="flex items-center space-x-1">
                          <ClockIcon className="w-4 h-4" />
                          <span>{formatDate(chatroom.createdAt)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  <Link
                    to={`/chatroom/${chatroom._id}`}
                    className="btn-primary w-full text-center"
                  >
                    Join Chatroom
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
