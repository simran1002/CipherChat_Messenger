import React, { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  UserIcon,
  EnvelopeIcon,
  LockClosedIcon,
  EyeIcon,
  EyeSlashIcon,
  ChatBubbleLeftRightIcon,
  CameraIcon,
} from "@heroicons/react/24/outline";
import makeToast from "../Toaster";
import api from "../services/api";

const RegisterPage = () => {
  const [formData, setFormData] = useState({
    username: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [dp, setDp] = useState(null);
  const [dpPreview, setDpPreview] = useState(null);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleDpChange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      makeToast("error", "Image must be less than 2MB");
      return;
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      setDp(reader.result);
      setDpPreview(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const registerUser = async (e) => {
    e.preventDefault();

    if (formData.password !== formData.confirmPassword) {
      makeToast("error", "Passwords do not match");
      return;
    }
    if (formData.password.length < 6) {
      makeToast("error", "Password must be at least 6 characters long");
      return;
    }

    setIsLoading(true);
    try {
      const response = await api.post("/user/register", {
        name: formData.username,
        email: formData.email,
        password: formData.password,
        dp,
      });
      makeToast("success", response.data.message);
      // Auto-login: store token and user, then go straight to dashboard
      localStorage.setItem("CC_Token", response.data.token);
      localStorage.setItem("CC_User", JSON.stringify(response.data.user));
      navigate("/");
    } catch (err) {
      makeToast(
        "error",
        err?.response?.data?.message || "An error occurred. Please try again."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const inputClasses =
    "w-full bg-gray-700/50 border border-gray-600 text-white rounded-xl pl-10 pr-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent placeholder-gray-500 transition-all";

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-primary-900/40 to-secondary-900/40 flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-secondary-500/10 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-primary-500/10 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
      >
        <div className="text-center mb-8">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
            className="w-16 h-16 bg-gradient-to-r from-primary-500 to-secondary-500 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-primary-500/25"
          >
            <ChatBubbleLeftRightIcon className="w-8 h-8 text-white" />
          </motion.div>
          <h1 className="text-3xl font-bold text-white mb-2">Join CipherChat</h1>
          <p className="text-gray-400">Create your account and start chatting securely</p>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="bg-gray-800/50 backdrop-blur-xl rounded-2xl p-8 border border-gray-700/50 shadow-2xl"
        >
          <form onSubmit={registerUser} className="space-y-5">
            <div className="flex flex-col items-center mb-2">
              <label className="relative cursor-pointer group">
                {dpPreview ? (
                  <img
                    src={dpPreview}
                    alt="Profile Preview"
                    className="w-20 h-20 rounded-full object-cover border-2 border-primary-400 shadow-lg"
                  />
                ) : (
                  <span className="w-20 h-20 rounded-full bg-gradient-to-br from-gray-600 to-gray-700 flex items-center justify-center shadow-lg border-2 border-gray-600">
                    <UserIcon className="w-10 h-10 text-gray-400" />
                  </span>
                )}
                <span className="absolute bottom-0 right-0 bg-primary-500 p-2 rounded-full shadow-lg border-2 border-gray-800 group-hover:bg-secondary-500 transition-colors duration-200">
                  <CameraIcon className="w-4 h-4 text-white" />
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleDpChange}
                />
              </label>
              <span className="text-xs text-gray-500 mt-2">
                Add a profile picture (optional, max 2MB)
              </span>
            </div>

            <div>
              <label htmlFor="username" className="block text-sm font-medium text-gray-300 mb-2">
                Username
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <UserIcon className="h-5 w-5 text-gray-500" />
                </div>
                <input
                  type="text"
                  name="username"
                  id="username"
                  value={formData.username}
                  onChange={handleChange}
                  className={inputClasses}
                  placeholder="Choose a username"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-300 mb-2">
                Email Address
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <EnvelopeIcon className="h-5 w-5 text-gray-500" />
                </div>
                <input
                  type="email"
                  name="email"
                  id="email"
                  value={formData.email}
                  onChange={handleChange}
                  className={inputClasses}
                  placeholder="Enter your email"
                  required
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-300 mb-2">
                Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <LockClosedIcon className="h-5 w-5 text-gray-500" />
                </div>
                <input
                  type={showPassword ? "text" : "password"}
                  name="password"
                  id="password"
                  value={formData.password}
                  onChange={handleChange}
                  className={`${inputClasses} pr-12`}
                  placeholder="Create a password (min 6 characters)"
                  required
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? (
                    <EyeSlashIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
                  ) : (
                    <EyeIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
                  )}
                </button>
              </div>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-300 mb-2">
                Confirm Password
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <LockClosedIcon className="h-5 w-5 text-gray-500" />
                </div>
                <input
                  type={showConfirmPassword ? "text" : "password"}
                  name="confirmPassword"
                  id="confirmPassword"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  className={`${inputClasses} pr-12`}
                  placeholder="Confirm your password"
                  required
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 pr-3 flex items-center"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                >
                  {showConfirmPassword ? (
                    <EyeSlashIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
                  ) : (
                    <EyeIcon className="h-5 w-5 text-gray-400 hover:text-gray-300" />
                  )}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full bg-gradient-to-r from-primary-500 to-secondary-500 hover:from-primary-600 hover:to-secondary-600 text-white font-semibold py-3 rounded-xl transition-all duration-200 shadow-lg shadow-primary-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <div className="flex items-center justify-center space-x-2">
                  <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  <span>Creating account...</span>
                </div>
              ) : (
                "Create Account"
              )}
            </button>
          </form>

          <div className="my-6">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-gray-600/50" />
              </div>
              <div className="relative flex justify-center text-sm">
                <span className="px-3 bg-gray-800/50 text-gray-400">Already have an account?</span>
              </div>
            </div>
          </div>

          <Link
            to="/login"
            className="block w-full text-center py-3 rounded-xl border border-gray-600 text-gray-300 hover:text-white hover:border-primary-500 hover:bg-primary-500/10 transition-all duration-200 font-medium"
          >
            Sign In
          </Link>
        </motion.div>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className="text-center text-sm text-gray-500 mt-6"
        >
          Your messages are encrypted and secure
        </motion.p>
      </motion.div>
    </div>
  );
};

export default RegisterPage;
