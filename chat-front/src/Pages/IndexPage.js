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
  UserGroupIcon,
  PaperAirplaneIcon,
  HeartIcon
} from "@heroicons/react/24/outline";

const features = [
  {
    icon: ShieldCheckIcon,
    title: "End-to-End Encryption",
    description: "Your messages are encrypted and secure, ensuring privacy and confidentiality."
  },
  {
    icon: BoltIcon,
    title: "Real-Time Messaging",
    description: "Instant message delivery with real-time updates and typing indicators."
  },
  {
    icon: UsersIcon,
    title: "Group Chatrooms",
    description: "Create and join chatrooms to connect with multiple users simultaneously."
  },
  {
    icon: DevicePhoneMobileIcon,
    title: "Mobile Friendly",
    description: "Enjoy a seamless experience on any device, anywhere, anytime."
  },
  {
    icon: GlobeAltIcon,
    title: "Global Access",
    description: "Connect with friends and colleagues around the world."
  },
  {
    icon: SparklesIcon,
    title: "Modern UI/UX",
    description: "Beautiful, animated, and professional design for a delightful experience."
  }
];

const IndexPage = () => {
  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 via-white to-secondary-50 relative overflow-hidden">
      {/* Animated Blobs and Sparkles */}
      <motion.div
        className="absolute -top-40 -left-40 w-[32rem] h-[32rem] bg-primary-200 rounded-full mix-blend-multiply filter blur-2xl opacity-60 animate-blob z-0"
        animate={{ scale: [1, 1.1, 0.9, 1] }}
        transition={{ repeat: Infinity, duration: 12, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute -bottom-40 -right-40 w-[32rem] h-[32rem] bg-secondary-200 rounded-full mix-blend-multiply filter blur-2xl opacity-60 animate-blob z-0"
        animate={{ scale: [1, 0.95, 1.1, 1] }}
        transition={{ repeat: Infinity, duration: 14, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-1/3 left-1/2 w-40 h-40 bg-primary-100 rounded-full mix-blend-multiply filter blur-2xl opacity-40 animate-blob z-0"
        animate={{ scale: [1, 1.2, 0.8, 1] }}
        transition={{ repeat: Infinity, duration: 10, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute top-1/4 right-1/3 w-24 h-24 bg-secondary-100 rounded-full mix-blend-multiply filter blur-2xl opacity-40 animate-blob z-0"
        animate={{ scale: [1, 0.8, 1.1, 1] }}
        transition={{ repeat: Infinity, duration: 11, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute bottom-1/4 left-1/4 w-16 h-16 bg-primary-100 rounded-full mix-blend-multiply filter blur-2xl opacity-30 animate-blob z-0"
        animate={{ scale: [1, 1.1, 0.9, 1] }}
        transition={{ repeat: Infinity, duration: 13, ease: "easeInOut" }}
      />
      {/* Sparkles */}
      <SparklesIcon className="absolute top-10 left-1/2 w-10 h-10 text-primary-300 opacity-60 animate-pulse z-10" />
      <SparklesIcon className="absolute bottom-10 right-1/3 w-8 h-8 text-secondary-300 opacity-60 animate-pulse z-10" />

      {/* Hero Section */}
      <section className="relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
          <div className="text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8 }}
            >
              <h1 className="text-5xl md:text-6xl font-bold text-gray-900 mb-6 drop-shadow-lg">
                Secure Messaging
                <span className="block bg-gradient-to-r from-primary-600 to-secondary-600 bg-clip-text text-transparent">
                  Made Simple
                </span>
              </h1>
              <p className="text-xl text-gray-600 mb-8 max-w-3xl mx-auto">
                Experience the future of communication with CipherChat. End-to-end encrypted messaging that keeps your conversations private and secure.
              </p>
              <div className="flex flex-col sm:flex-row gap-4 justify-center">
                <motion.div
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                >
                  <Link
                    to="/register"
                    className="btn-primary text-lg px-8 py-4 inline-flex items-center space-x-2 shadow-lg"
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
                    className="btn-outline text-lg px-8 py-4 inline-flex items-center space-x-2 shadow"
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
      <section className="py-20 bg-white/80 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
            className="text-center mb-16"
          >
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4">
              Why Choose CipherChat?
            </h2>
            <p className="text-lg text-gray-600 max-w-2xl mx-auto">
              Built with security and user experience in mind, CipherChat provides everything you need for safe communication.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8">
            {features.map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8, delay: index * 0.15 }}
                viewport={{ once: true }}
                className="card p-8 text-center hover:shadow-xl transition-shadow duration-300 bg-gradient-to-br from-white via-primary-50 to-secondary-50 border-0"
              >
                <div className="w-16 h-16 mx-auto mb-6 flex items-center justify-center rounded-full bg-gradient-to-r from-primary-600 to-secondary-600 shadow-lg">
                  <feature.icon className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-xl font-semibold text-gray-900 mb-4 flex items-center justify-center gap-2">
                  {feature.title}
                </h3>
                <p className="text-gray-600">
                  {feature.description}
                </p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 bg-gradient-to-r from-primary-600 to-secondary-600 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8 }}
            viewport={{ once: true }}
          >
            <h2 className="text-3xl md:text-4xl font-bold text-white mb-4 flex items-center justify-center gap-2">
              Ready to Start Chatting?
              <HeartIcon className="w-7 h-7 text-pink-200 animate-pulse" />
            </h2>
            <p className="text-xl text-primary-100 mb-8 max-w-2xl mx-auto">
              Join thousands of users who trust CipherChat for their secure messaging needs.
            </p>
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
            >
              <Link
                to="/register"
                className="bg-white text-primary-600 hover:bg-gray-50 font-semibold py-3 px-8 rounded-lg inline-flex items-center space-x-2 transition-colors duration-200 shadow-lg"
              >
                <span>Create Free Account</span>
                <ArrowRightIcon className="w-5 h-5" />
              </Link>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-gray-900 text-white py-12 relative z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <div className="flex items-center justify-center space-x-2 mb-4">
              <div className="w-8 h-8 bg-gradient-to-r from-primary-600 to-secondary-600 rounded-lg flex items-center justify-center">
                <ChatBubbleLeftRightIcon className="w-5 h-5 text-white" />
              </div>
              <span className="text-xl font-bold">CipherChat</span>
            </div>
            <p className="text-gray-400 mb-4">
              Secure messaging for the modern world
            </p>
            <div className="flex justify-center space-x-6 text-sm text-gray-400">
              <span className="flex items-center gap-1"><LockClosedIcon className="w-4 h-4" /> Privacy Policy</span>
              <span className="flex items-center gap-1"><UserGroupIcon className="w-4 h-4" /> Terms of Service</span>
              <span className="flex items-center gap-1"><GlobeAltIcon className="w-4 h-4" /> Contact</span>
            </div>
            <p className="text-gray-500 text-sm mt-6">
              © 2024 CipherChat. All rights reserved.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default IndexPage;
