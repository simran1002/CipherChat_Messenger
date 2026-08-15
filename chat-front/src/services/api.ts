import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

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
// call /user/refresh (httpOnly rotating cookie), store the new access token,
// and replay the original request once. Concurrent 401s share one refresh.

let refreshPromise: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = axios
      .post<{ token: string }>(`${API_URL}/user/refresh`, null, { withCredentials: true })
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
      if (!url.includes("/user/refresh") && !url.includes("/user/login") && !url.includes("/user/register")) {
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

export const getApiUrl = (): string => API_URL;
export { refreshAccessToken };

export default api;
