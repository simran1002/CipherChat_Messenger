/**
 * Page-side handle on the search worker. Promise API; the worker is created lazily on first use.
 * Where Workers are unavailable (tests, very old browsers) every call resolves to an empty result
 * and the caller's substring fallback still works.
 */
import type { SearchDoc, SearchHit, SearchOptions } from "./searchCore";
import type { WorkerRequest, WorkerResponse } from "./search.worker";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };
type RequestBody = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === "undefined") return null;
  try {
    worker = new Worker(new URL("./search.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const res = event.data;
      const p = pending.get(res.id);
      if (!p) return;
      pending.delete(res.id);
      if (res.ok) p.resolve(res.result);
      else p.reject(new Error(res.error));
    };
    worker.onerror = () => {
      for (const p of pending.values()) p.reject(new Error("search worker crashed"));
      pending.clear();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function call<T>(body: RequestBody, fallback: T): Promise<T> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(fallback);
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...body, id } as WorkerRequest);
  }).catch(() => fallback);
}

/** Index decrypted messages. Safe to call repeatedly with the same docs (dedupes on id + text). */
export function indexMessages(docs: SearchDoc[]): Promise<{ changed: number; size: number }> {
  if (docs.length === 0) return Promise.resolve({ changed: 0, size: 0 });
  return call({ op: "index", docs }, { changed: 0, size: 0 });
}

export function searchMessages(term: string, options?: SearchOptions): Promise<SearchHit[]> {
  return call({ op: "search", term, options }, [] as SearchHit[]);
}

export function removeMessage(messageId: string): Promise<{ removed: boolean }> {
  return call({ op: "remove", messageId }, { removed: false });
}

/** Cryptographic shredding hook: drop one conversation from the index and delete its snapshot. */
export function shredConversationIndex(convId: string): Promise<{ removed: number }> {
  return call({ op: "shred", convId }, { removed: 0 });
}

/** Logout / identity reset. */
export function wipeSearchIndex(): Promise<{ wiped: boolean }> {
  return call({ op: "wipe" }, { wiped: false });
}
