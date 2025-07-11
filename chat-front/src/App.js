import React, { useState, useEffect } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LoginPage from "./Pages/LoginPage";
import RegisterPage from "./Pages/RegisterPage";
import DashboardPage from "./Pages/DashboardPage";
import IndexPage from "./Pages/IndexPage";
import ChatroomPage from "./Pages/ChatroomPage";
import Header from "./components/Header";
import Toaster from "./components/Toaster";

import io from "socket.io-client";

function App() {
  const [socket, setSocket] = useState(null);
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const setupSocket = () => {
    const token = localStorage.getItem("CC_Token");
    if (token && !socket) {
      const newSocket = io("https://cipherchat-messenger.onrender.com", {
        query: {
          token: localStorage.getItem("CC_Token"),
        },
      });

      newSocket.on("disconnect", () => {
        setSocket(null);
        setTimeout(setupSocket, 3000);
        if (window.makeToast) {
          window.makeToast("error", "Socket Disconnected!");
        }
      });

      newSocket.on("connect", () => {
        if (window.makeToast) {
          window.makeToast("success", "Socket Connected!");
        }
      });

      setSocket(newSocket);
    }
  };

  const handleLogout = () => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
    }
    setUser(null);
    localStorage.removeItem("CC_Token");
    localStorage.removeItem("CC_User");
  };

  const getUserFromToken = () => {
    const token = localStorage.getItem("CC_Token");
    const userStr = localStorage.getItem("CC_User");
    if (token && userStr) {
      try {
        const userObj = JSON.parse(userStr);
        setUser(userObj);
        return userObj;
      } catch (error) {
        localStorage.removeItem("CC_User");
        return null;
      }
    }
    return null;
  };

  useEffect(() => {
    const userData = getUserFromToken();
    if (userData) {
      setupSocket();
    }
    setIsLoading(false);
  }, []);

  // Protected Route Component
  const ProtectedRoute = ({ children }) => {
    const token = localStorage.getItem("CC_Token");
    if (!token) {
      return <Navigate to="/login" replace />;
    }
    return children;
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
          <p className="text-gray-600">Loading CipherChat...</p>
        </div>
      </div>
    );
  }

  return (
    <Router>
      <div className="min-h-screen bg-gray-50">
        <Header user={user} onLogout={handleLogout} />
        <main>
          <Routes>
            <Route path="/" element={<IndexPage />} />
            <Route 
              path="/login" 
              element={
                user ? <Navigate to="/dashboard" replace /> : <LoginPage setupSocket={setupSocket} setUser={setUser} />
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
                  <ChatroomPage socket={socket} />
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