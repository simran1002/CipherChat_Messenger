/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /**
   * Comma-separated socket.io transports, default "websocket,polling".
   * Build with "websocket" only for the least_conn LB profile — without the
   * HTTP long-polling fallback there is no sticky-session requirement.
   */
  readonly VITE_SOCKET_TRANSPORTS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  makeToast?: (type: "success" | "error" | "info" | "warning", message: string) => void;
}
