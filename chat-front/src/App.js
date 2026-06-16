import React, { useState, useEffect, useCallback, useRef } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import LoginPage from "./Pages/LoginPage";
import RegisterPage from "./Pages/RegisterPage";
import DashboardPage from "./Pages/DashboardPage";
import IndexPage from "./Pages/IndexPage";
import ChatroomPage from "./Pages/ChatroomPage";
import DirectMessagesPage from "./Pages/DirectMessagesPage";
import ProfilePage from "./Pages/ProfilePage";
import Header from "./components/Header";
import Toaster from "./components/Toaster";
import io from "socket.io-client";
import { getApiUrl } from "./services/api";

function App() {
  const [socket, setSocket] = useState(null);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const socketRef = useRef(null);

  const setupSocket = useCallback(() => {
    const token = localStorage.getItem("CC_Token");
    if (token && !socketRef.current) {
      const newSocket = io(getApiUrl(), {
        query: { token },
        transports: ["websocket", "polling"],
      });

      newSocket.on("connect", () => {
        if (window.makeToast) {
          window.makeToast("success", "Connected to chat server");
        }
      });

      newSocket.on("disconnect", (reason) => {
        if (reason === "io server disconnect") {
          newSocket.connect();
        }
      });

      newSocket.on("connect_error", (err) => {
        console.error("Socket connection error:", err.message);
      });

      socketRef.current = newSocket;
      setSocket(newSocket);
    }
  }, []);

  const handleLogout = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }
    setSocket(null);
    setUser(null);
    localStorage.removeItem("CC_Token");
    localStorage.removeItem("CC_User");
  }, []);

  useEffect(() => {
    const token = localStorage.getItem("CC_Token");
    const userStr = localStorage.getItem("CC_User");
    if (token && userStr) {
      try {
        const userObj = JSON.parse(userStr);
        setUser(userObj);
        setupSocket();
      } catch {
        localStorage.removeItem("CC_User");
      }
    }
    setIsLoading(false);

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [setupSocket]);

  const ProtectedRoute = ({ children }) => {
    const token = localStorage.getItem("CC_Token");
    if (!token) return <Navigate to="/login" replace />;
    return children;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-gray-900 via-primary-900 to-secondary-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-primary-400 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-primary-200 text-lg font-medium">Loading CipherChat...</p>
        </div>
      </div>
    );
  }

  return (
    <Router>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <Header user={user} onLogout={handleLogout} socket={socket} />
        <main>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route
              path="/login"
              element={
                user ? (
                  <Navigate to="/dashboard" replace />
                ) : (
                  <LoginPage setupSocket={setupSocket} setUser={setUser} />
                )
              }
            />
            <Route
              path="/register"
              element={
                user ? <Navigate to="/dashboard" replace /> : <RegisterPage />
              }
            />
            <Route
              path="/dashboard"
              element={
                <ProtectedRoute>
                  <DashboardPage socket={socket} />
                </ProtectedRoute>
              }
            />
            <Route
              path="/chatroom/:chatroomId"
              element={
                <ProtectedRoute>
                  <ChatroomPage socket={socket} user={user} />
                </ProtectedRoute>
              }
            />
            <Route
              path="/messages"
              element={
                <ProtectedRoute>
                  <DirectMessagesPage socket={socket} user={user} />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <ProfilePage user={user} setUser={setUser} />
                </ProtectedRoute>
              }
            />
          </Routes>
        </main>
        <Toaster />
      </div>
    </Router>
  );
}

export default App;
