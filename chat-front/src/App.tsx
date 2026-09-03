import { lazy, Suspense, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { createStompSocket } from "./services/stompSocket";
import Header from "./components/Header";
import Toaster from "./components/Toaster";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SocketContext } from "./contexts/SocketContext";
import api, { getSocketUrl, refreshAccessToken } from "./services/api";
import * as heartbeatSvc from "./services/HeartbeatService";
import type { AppSocket, AuthUser } from "./types";

const IndexPage = lazy(() => import("./Pages/IndexPage"));
const LoginPage = lazy(() => import("./Pages/LoginPage"));
const RegisterPage = lazy(() => import("./Pages/RegisterPage"));
const DashboardPage = lazy(() => import("./Pages/DashboardPage"));
const ChatroomPage = lazy(() => import("./Pages/ChatroomPage"));
const DirectMessagesPage = lazy(() => import("./Pages/DirectMessagesPage"));
const ProfilePage = lazy(() => import("./Pages/ProfilePage"));
const MetricsDashboardPage = lazy(() => import("./Pages/MetricsDashboardPage"));

// Hoisted out of App() — an inline definition re-created the component type on
// every render and remounted the whole protected subtree.
function ProtectedRoute({ children }: { children: ReactNode }) {
  const token = localStorage.getItem("CC_Token");
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

function FullScreenSpinner({ label }: { label: string }) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-primary-900 to-secondary-900 flex items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 border-4 border-primary-400 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
        <p className="text-primary-200 text-lg font-medium">{label}</p>
      </div>
    </div>
  );
}

function App() {
  const [socket, setSocket] = useState<AppSocket | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const socketRef = useRef<AppSocket | null>(null);

  const setupSocket = useCallback(() => {
    const token = localStorage.getItem("CC_Token");
    if (token && !socketRef.current) {
      // The STOMP client re-reads CC_Token from storage on every (re)connect
      // attempt (see stompSocket.ts's beforeConnect), so a token rotated by
      // the silent-refresh interceptor is picked up automatically — no auth
      // payload to pass here. `createStompSocket` activates the client and
      // it auto-reconnects (reconnectDelay) on its own after a drop.
      const newSocket: AppSocket = createStompSocket(getSocketUrl());

      newSocket.on("connect", () => {
        window.makeToast?.("success", "Connected to chat server");
        // Presence heartbeat for the socket's whole lifetime — it used to run
        // only while the chatroom page was mounted, so users browsing the
        // dashboard/profile/DMs were marked offline after ~60s.
        heartbeatSvc.start(newSocket);
      });

      newSocket.on("disconnect", () => {
        heartbeatSvc.stop();
      });

      newSocket.on("connect_error", (err) => {
        console.error("Socket connection error:", err.message);
        // Expired access token at the CONNECT frame — refresh now so the
        // client's next (automatic) reconnect attempt picks up a good token.
        if (err.message === "Invalid token") {
          void refreshAccessToken();
        }
      });

      socketRef.current = newSocket;
      setSocket(newSocket);
    }
  }, []);

  const handleLogout = useCallback(() => {
    // Revoke the refresh session server-side (best-effort)
    void api.post("/api/v1/auth/logout", null, { withCredentials: true }).catch(() => {});
    heartbeatSvc.stop();
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
        const userObj = JSON.parse(userStr) as AuthUser;
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

  if (isLoading) {
    return <FullScreenSpinner label="Loading CipherChat..." />;
  }

  return (
    <ThemeProvider>
      <SocketContext.Provider value={{ socket, setupSocket, logout: handleLogout }}>
        <Router>
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
            <Header user={user} onLogout={handleLogout} />
            <main>
              <Suspense fallback={<FullScreenSpinner label="Loading..." />}>
                <Routes>
                  <Route path="/" element={<IndexPage />} />
                  <Route
                    path="/login"
                    element={
                      user ? (
                        <Navigate to="/dashboard" replace />
                      ) : (
                        <LoginPage setUser={setUser} />
                      )
                    }
                  />
                  <Route
                    path="/register"
                    element={user ? <Navigate to="/dashboard" replace /> : <RegisterPage />}
                  />
                  <Route
                    path="/dashboard"
                    element={
                      <ProtectedRoute>
                        <DashboardPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/chatroom/:chatroomId"
                    element={
                      <ProtectedRoute>
                        <ChatroomPage user={user} />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="/messages"
                    element={
                      <ProtectedRoute>
                        <DirectMessagesPage user={user} />
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
                  <Route
                    path="/metrics"
                    element={
                      <ProtectedRoute>
                        <MetricsDashboardPage />
                      </ProtectedRoute>
                    }
                  />
                  <Route
                    path="*"
                    element={
                      <div className="min-h-screen flex flex-col items-center justify-center text-gray-500 dark:text-gray-300">
                        <p className="text-6xl font-bold mb-2">404</p>
                        <p className="mb-4">This page does not exist.</p>
                        <a href="/" className="text-primary-500 hover:underline">
                          Back to home
                        </a>
                      </div>
                    }
                  />
                </Routes>
              </Suspense>
            </main>
            <Toaster />
          </div>
        </Router>
      </SocketContext.Provider>
    </ThemeProvider>
  );
}

export default App;
