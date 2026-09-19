/**
 * Full-text index over DECRYPTED direct messages — it exists only on the device.
 *
 * The server cannot search E2EE content (it holds ciphertext), so search happens where the
 * plaintext already is. This core is a thin, testable wrapper around Orama: typo-tolerant,
 * stemmed, ranked, filterable by conversation. It knows nothing about workers, storage or
 * crypto — search.worker.ts hosts it off the main thread and snapshotCrypto.ts keeps what it
 * persists encrypted at rest.
 */
import { create, insert, remove, search, type AnyOrama } from "@orama/orama";

export interface SearchDoc {
  /** Server message id — the dedupe key. */
  id: string;
  convId: string;
  sender: string;
  text: string;
  /** Epoch millis; used to order equal-score hits newest first. */
  ts: number;
}

export interface SearchHit {
  id: string;
  convId: string;
  score: number;
  ts: number;
  /** Included so a cross-conversation result (global search) can show a snippet without a second lookup. */
  text: string;
  sender: string;
}

export interface SearchOptions {
  convId?: string;
  limit?: number;
  /** Max edit distance per term (0 = exact). Default 1. */
  tolerance?: number;
}

const SCHEMA = { id: "string", convId: "enum", sender: "string", text: "string", ts: "number" } as const;

export class SearchCore {
  private db: AnyOrama;
  private docs = new Map<string, SearchDoc>();

  private constructor(db: AnyOrama) {
    this.db = db;
  }

  static async create(): Promise<SearchCore> {
    return new SearchCore(await create({ schema: SCHEMA, components: { tokenizer: { stemming: true } } }));
  }

  get size(): number {
    return this.docs.size;
  }

  /** Insert or replace. Returns false when an identical doc was already indexed (no work done). */
  async add(doc: SearchDoc): Promise<boolean> {
    const existing = this.docs.get(doc.id);
    if (existing) {
      if (existing.text === doc.text && existing.convId === doc.convId) return false;
      await remove(this.db, doc.id);
    }
    if (!doc.text || doc.text.trim().length === 0) {
      this.docs.delete(doc.id);
      return Boolean(existing);
    }
    await insert(this.db, { ...doc });
    this.docs.set(doc.id, doc);
    return true;
  }

  async addAll(docs: SearchDoc[]): Promise<number> {
    let changed = 0;
    for (const d of docs) if (await this.add(d)) changed++;
    return changed;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.docs.has(id)) return false;
    await remove(this.db, id);
    this.docs.delete(id);
    return true;
  }

  /** Remove every document of a conversation (used by cryptographic shredding). */
  async deleteConversation(convId: string): Promise<number> {
    const ids = [...this.docs.values()].filter((d) => d.convId === convId).map((d) => d.id);
    for (const id of ids) await this.delete(id);
    return ids.length;
  }

  async search(term: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const q = term.trim();
    if (q.length === 0) return [];
    const res = await search(this.db, {
      term: q,
      properties: ["text", "sender"],
      tolerance: options.tolerance ?? 1,
      limit: options.limit ?? 50,
      ...(options.convId ? { where: { convId: { eq: options.convId } } } : {}),
    });
    return res.hits
      .map((h) => {
        const d = h.document as unknown as SearchDoc;
        return { id: d.id, convId: d.convId, score: h.score, ts: d.ts, text: d.text, sender: d.sender };
      })
      .sort((a, b) => b.score - a.score || b.ts - a.ts);
  }

  conversations(): string[] {
    return [...new Set([...this.docs.values()].map((d) => d.convId))];
  }

  /** Plain docs of one conversation — what gets encrypted into a snapshot. */
  exportConversation(convId: string): SearchDoc[] {
    return [...this.docs.values()].filter((d) => d.convId === convId).sort((a, b) => a.ts - b.ts);
  }
}
