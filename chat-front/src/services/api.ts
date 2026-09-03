import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";

// Unset → same origin. In dev that means the Vite proxy (vite.config.ts);
// production images bake an absolute URL at build time.
const API_URL = import.meta.env.VITE_API_URL || "";

const api = axios.create({
  baseURL: API_URL,
  timeout: 15000,
  // Refresh-token cookie (httpOnly) rides on every request; the server's
  // CORS config allows credentials for the explicit origin allowlist only.
  withCredentials: true,
});

api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem("CC_Token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ── Silent refresh ────────────────────────────────────────────────────────────
// Access tokens expire after 15 minutes. On the first 401 for a request we
// call /api/v1/auth/refresh (httpOnly rotating cookie), store the new access
// token, and replay the original request once. Concurrent 401s share one refresh.

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post<{ token: string }>(`${API_URL}/api/v1/auth/refresh`, null, { withCredentials: true })
      .then((res) => {
        localStorage.setItem("CC_Token", res.data.token);
        return res.data.token;
      })
      .catch(() => null)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

function clearSessionAndRedirect(): void {
  localStorage.removeItem("CC_Token");
  localStorage.removeItem("CC_User");
  if (window.location.pathname !== "/login" && window.location.pathname !== "/") {
    window.location.href = "/login";
  }
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const original = error.config as (InternalAxiosRequestConfig & { _retried?: boolean }) | undefined;

    if (error.response?.status === 401 && original && !original._retried) {
      // Never try to refresh the refresh call itself or login/register
      const url = original.url ?? "";
      if (
        !url.includes("/api/v1/auth/refresh") &&
        !url.includes("/api/v1/auth/login") &&
        !url.includes("/api/v1/auth/register")
      ) {
        const token = await refreshAccessToken();
        if (token) {
          original._retried = true;
          original.headers.Authorization = `Bearer ${token}`;
          return api(original);
        }
      }
      clearSessionAndRedirect();
    }
    return Promise.reject(error);
  }
);

/** Base URL for REST, sockets, and absolutizing `/uploads/...` paths ("" = same origin). */
export const getApiUrl = (): string => API_URL;

/** Absolute origin for the STOMP socket (a bare "" won't build a valid ws:// URL). */
export const getSocketUrl = (): string => API_URL || window.location.origin;
export { refreshAccessToken };

/**
 * RFC 9457 problem body → a human message. The Java backend puts the
 * human-readable text in `detail`; `message` is kept as a fallback for any
 * response shaped like the old Node backend's `{message}`.
 */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { detail?: string; message?: string } } })?.response?.data;
  return data?.detail || data?.message || fallback;
}

export default api;
