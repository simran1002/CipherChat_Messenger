/// <reference lib="webworker" />
/**
 * Search worker: hosts the index off the main thread so indexing a long decrypted history never
 * blocks typing or scrolling. Snapshots are written encrypted, per conversation, debounced.
 */
import { SearchCore, type SearchDoc, type SearchOptions } from "./searchCore";
import { deleteSnapshot, loadAllSnapshots, saveSnapshot, wipeSearchStore } from "./snapshotStore";

export type WorkerRequest =
  | { id: number; op: "hydrate" }
  | { id: number; op: "index"; docs: SearchDoc[] }
  | { id: number; op: "search"; term: string; options?: SearchOptions }
  | { id: number; op: "remove"; messageId: string }
  | { id: number; op: "shred"; convId: string }
  | { id: number; op: "wipe" };

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

const PERSIST_DEBOUNCE_MS = 1500;

let core: SearchCore | null = null;
let hydrated: Promise<void> | null = null;
const dirty = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

async function ensureCore(): Promise<SearchCore> {
  if (!core) core = await SearchCore.create();
  if (!hydrated) {
    const c = core;
    hydrated = loadAllSnapshots()
      .then((docs) => c.addAll(docs))
      .then(() => undefined)
      .catch(() => undefined); // storage blocked: run in-memory only
  }
  await hydrated;
  return core;
}

function schedulePersist(convIds: Iterable<string>): void {
  for (const c of convIds) dirty.add(c);
  if (timer) return;
  timer = setTimeout(async () => {
    timer = null;
    const batch = [...dirty];
    dirty.clear();
    const c = await ensureCore();
    for (const convId of batch) {
      try {
        await saveSnapshot(convId, c.exportConversation(convId));
      } catch {
        dirty.add(convId); // quota or transient IDB error: retry with the next batch
      }
    }
  }, PERSIST_DEBOUNCE_MS);
}

async function handle(req: WorkerRequest): Promise<unknown> {
  const c = await ensureCore();
  switch (req.op) {
    case "hydrate":
      return { size: c.size };
    case "index": {
      const changed = await c.addAll(req.docs);
      if (changed > 0) schedulePersist(new Set(req.docs.map((d) => d.convId)));
      return { changed, size: c.size };
    }
    case "search":
      return c.search(req.term, req.options);
    case "remove": {
      const convs = c.conversations();
      const removed = await c.delete(req.messageId);
      if (removed) schedulePersist(convs);
      return { removed };
    }
    case "shred": {
      const removed = await c.deleteConversation(req.convId);
      dirty.delete(req.convId);
      await deleteSnapshot(req.convId);
      return { removed };
    }
    case "wipe":
      core = await SearchCore.create();
      dirty.clear();
      await wipeSearchStore();
      return { wiped: true };
  }
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  handle(req)
    .then((result) => (self as DedicatedWorkerGlobalScope).postMessage({ id: req.id, ok: true, result } satisfies WorkerResponse))
    .catch((e: unknown) =>
      (self as DedicatedWorkerGlobalScope).postMessage({
        id: req.id,
        ok: false,
        error: e instanceof Error ? e.message : "search worker error",
      } satisfies WorkerResponse)
    );
};
