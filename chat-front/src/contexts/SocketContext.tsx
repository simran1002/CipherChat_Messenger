
import { createContext, useContext } from "react";
import type { AppSocket } from "../types";

export interface SocketContextValue {
  socket: AppSocket | null;
  /** Connect the singleton socket if a token exists and none is connected yet. */
  setupSocket: () => void;
  /** Disconnect and clear stored credentials. */
  logout: () => void;
}

export const SocketContext = createContext<SocketContextValue>({
  socket: null,
  setupSocket: () => {},
  logout: () => {},
});

export function useSocket(): SocketContextValue {
  return useContext(SocketContext);
}
