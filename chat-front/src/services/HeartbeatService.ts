/**
 * Sends a heartbeat ping to the server every 25 seconds.
 * The server auto-marks the user offline if 2 pings are missed (~60s).
 * Call start(socket) on connect, stop() on unmount/disconnect.
 */
import type { AppSocket } from "../types";

const INTERVAL_MS = 25_000;

let _timer: ReturnType<typeof setInterval> | null = null;

export function start(socket: AppSocket): void {
  stop();
  _timer = setInterval(() => {
    if (socket?.connected) socket.emit("heartbeat");
  }, INTERVAL_MS);
}

export function stop(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
