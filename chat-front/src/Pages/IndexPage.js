import React from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ChatBubbleLeftRightIcon,
  ShieldCheckIcon,
  BoltIcon,
  UsersIcon,
  ArrowRightIcon,
  DevicePhoneMobileIcon,
  GlobeAltIcon,
  SparklesIcon,
  LockClosedIcon,
  PaperAirplaneIcon,
} from "@heroicons/react/24/outline";

const features = [
  {
    icon: ShieldCheckIcon,
    title: "Secure Authentication",
    description:
      "Industry-standard bcrypt hashing and JWT tokens keep your account safe.",
    color: "from-blue-500 to-cyan-500",
  },
  {
    icon: BoltIcon,
    title: "Real-Time Messaging",
    description:
      "Instant message delivery powered by Socket.io with typing indicators.",
    color: "from-yellow-500 to-orange-500",
  },
  {
    icon: UsersIcon,
    title: "Group Chatrooms",
    description:
      "Create and join chatrooms to connect with multiple users at once.",
    color: "from-purple-500 to-pink-500",
  },
  {
    icon: DevicePhoneMobileIcon,
    title: "Fully Responsive",
    description:
      "Seamless experience across desktop, tablet, and mobile devices.",
    color: "from-green-500 to-emerald-500",
  },
  {
    icon: GlobeAltIcon,
    title: "Global Access",
    description:
      "Connect with friends and colleagues from anywhere in the world.",
    color: "from-indigo-500 to-violet-500",
  },
  {
    icon: SparklesIcon,
    title: "Modern Design",
    description:
      "Beautiful dark theme with smooth animations for a delightful experience.",
    color: "from-rose-500 to-pink-500",
  },
];

const IndexPage = () => {
  return (
    <div className="min-h-screen bg-gray-900 relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -left-40 w-[500px] h-[500px] bg-primary-500/5 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -right-40 w-[600px] h-[600px] bg-secondary-500/5 rounded-full blur-3xl" />
        <div className="absolute top-1/3 right-1/4 w-[300px] h-[300px] bg-primary-500/3 rounded-full blur-3xl" />
      </div>

      {/* Hero Section */}
      <section className="relative z-10 pt-20 pb-32">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center max-w-4xl mx-auto">
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              <div className="inline-flex items-center gap-2 bg-primary-500/10 border border-primary-500/20 rounded-full px-4 py-1.5 mb-8">
                <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                <span className="text-primary-300 text-sm font-medium">
                  Live and ready to chat
                </span>
              </div>
              <h1 className="text-5xl sm:text-6xl md:text-7xl font-bold text-white mb-6 leading-tight">
                Secure Messaging
                <span className="block bg-gradient-to-r from-primary-400 to-secondary-400 bg-clip-text text-transparent">
                  Made Simple
                </span>
              </h1>
              <p className="text-lg sm:text-xl text-gray-400 mb-10 max-w-2xl mx-auto leading-relaxed">
                Experience real-time communication with CipherChat. Create
                chatrooms, connect with others, and enjoy a modern messaging
                platform built with the MERN stack.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Link
                    to="/register"
                    className="inline-flex items-center space-x-2 bg-gradient-to-r from-primary-500 to-secondary-500 hover:from-primary-600 hover:to-secondary-600 text-white font-semibold text-lg px-8 py-4 rounded-xl shadow-lg shadow-primary-500/25 transition-all"
                  >
                    <span>Start Chatting</span>
                    <PaperAirplaneIcon className="w-5 h-5" />
                  </Link>
                </motion.div>
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Link
                    to="/login"
                    className="inline-flex items-center space-x-2 border border-gray-600 hover:border-primary-500 text-gray-300 hover:text-white font-semibold text-lg px-8 py-4 rounded-xl hover:bg-primary-500/10 transition-all"
                  >
                    <span>Sign In</span>
                    <LockClosedIcon className="w-5 h-5" />
                  </Link>
                </motion.div>
              </div>
            </motion.div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section className="py-24 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              Why Choose CipherChat?
            </h2>
            <p className="text-lg text-gray-400 max-w-2xl mx-auto">
              Built with modern technologies and best practices for a fast,
              secure, and enjoyable messaging experience.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                viewport={{ once: true }}
                className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-2xl p-7 hover:border-gray-600/50 hover:bg-gray-800/80 transition-all duration-300 group"
              >
                <div
                  className={`w-12 h-12 rounded-xl bg-gradient-to-r ${feature.color} flex items-center justify-center mb-5 shadow-lg group-hover:scale-110 transition-transform`}
                >
                  <feature.icon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-semibold text-white mb-2">
                  {feature.title}
                </h3>
                <p className="text-gray-400 text-sm leading-relaxed">
                  {feature.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-24 relative z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="bg-gradient-to-r from-primary-500/10 to-secondary-500/10 border border-primary-500/20 rounded-3xl p-10 sm:p-14 text-center"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
              Ready to Start Chatting?
            </h2>
            <p className="text-lg text-gray-400 mb-8 max-w-xl mx-auto">
              Join CipherChat today and experience real-time messaging with a
              modern, beautiful interface.
            </p>
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Link
                to="/register"
                className="inline-flex items-center space-x-2 bg-white text-gray-900 hover:bg-gray-100 font-semibold py-3.5 px-8 rounded-xl transition-colors shadow-lg"
              >
                <span>Create Free Account</span>
                <ArrowRightIcon className="w-5 h-5" />
              </Link>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-800 py-10 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="flex items-center justify-center space-x-2 mb-3">
              <div className="w-8 h-8 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-lg flex items-center justify-center">
                <ChatBubbleLeftRightIcon className="w-5 h-5 text-white" />
              </div>
              <span className="text-lg font-bold text-white">CipherChat</span>
            </div>
            <p className="text-gray-500 text-sm">
              Built with React, Node.js, Express, MongoDB & Socket.io
            </p>
            <p className="text-gray-600 text-xs mt-3">
              &copy; {new Date().getFullYear()} CipherChat. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default IndexPage;
