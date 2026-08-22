import { lazy, Suspense, useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { BrowserRouter as Router, Routes, Route, Navigate } from "react-router-dom";
import { io } from "socket.io-client";
import Header from "./components/Header";
import Toaster from "./components/Toaster";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SocketContext } from "./contexts/SocketContext";
import api, { getApiUrl, refreshAccessToken } from "./services/api";
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
      const newSocket: AppSocket = io(getApiUrl(), {
        // auth payload — not the query string, which proxies log. The callback
        // form re-reads storage on every reconnect attempt, so a token rotated
        // by the silent-refresh interceptor is picked up automatically.
        auth: (cb) => cb({ token: localStorage.getItem("CC_Token") }),
        transports: ["websocket", "polling"],
      });

      newSocket.on("connect", () => {
        window.makeToast?.("success", "Connected to chat server");
      });

      newSocket.on("disconnect", (reason) => {
        if (reason === "io server disconnect") {
          newSocket.connect();
        }
      });

      newSocket.on("connect_error", (err) => {
        console.error("Socket connection error:", err.message);
        // Expired access token at handshake — refresh, then let the auth
        // callback pick up the new token on the next connect attempt.
        if (err.message === "Invalid token") {
          void refreshAccessToken().then((t) => {
            if (t) newSocket.connect();
          });
        }
      });

      socketRef.current = newSocket;
      setSocket(newSocket);
    }
  }, []);

  const handleLogout = useCallback(() => {
    // Revoke the refresh session server-side (best-effort)
    void api.post("/user/logout", null, { withCredentials: true }).catch(() => {});
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
            <Header user={user} onLogout={handleLogout} socket={socket} />
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
                        <LoginPage setupSocket={setupSocket} setUser={setUser} />
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
