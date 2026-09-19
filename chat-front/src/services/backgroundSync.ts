/**
 * Registers the queue-flushing service worker (public/sw.js) and asks the browser to run it when
 * connectivity returns. Background Sync exists in Chromium only; elsewhere the worker is nudged
 * on the `online` event, and the page's own reconnect drain remains the primary path everywhere.
 */
import { getApiUrl } from "./api";

const SYNC_TAG = "cipherchat-outbox";

interface SyncCapableRegistration extends ServiceWorkerRegistration {
  sync?: { register(tag: string): Promise<void> };
}

let registration: SyncCapableRegistration | null = null;

export async function registerBackgroundSync(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  try {
    registration = (await navigator.serviceWorker.register("/sw.js")) as SyncCapableRegistration;
    const worker = registration.active ?? registration.waiting ?? registration.installing;
    worker?.postMessage({ type: "config", apiBase: getApiUrl() });
    window.addEventListener("online", () => void requestOutboxFlush());
    return true;
  } catch {
    return false; // private mode / blocked storage: the page drain still works
  }
}

/** Call after enqueueing offline work: schedules a flush for when the network is back. */
export async function requestOutboxFlush(): Promise<void> {
  if (!registration) return;
  try {
    if (registration.sync) {
      await registration.sync.register(SYNC_TAG);
    } else {
      registration.active?.postMessage({ type: "flush-outbox" });
    }
  } catch {
    // permission denied or unsupported: the reconnect drain covers it
  }
}
