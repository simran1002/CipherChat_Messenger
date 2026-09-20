import { API } from "./api";

/**
 * A minimal STOMP 1.2 client over the platform WebSocket (Node 22+), just enough to act as a real —
 * or hostile — client of the gateway without pulling in the application's own client library. Raw frames
 * are the point: the tests below send things the shipped UI never would.
 */
export interface Frame {
  command: string;
  headers: Record<string, string>;
  body: string;
}

export class StompClient {
  private readonly frames: Frame[] = [];
  private waiters: ((f: Frame | null) => void)[] = [];
  private subs = 0;
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      for (const raw of String(event.data).split("\0")) {
        const frame = parse(raw);
        if (!frame) continue;
        const waiter = this.waiters.shift();
        if (waiter) waiter(frame);
        else this.frames.push(frame);
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  static async connect(token: string): Promise<StompClient> {
    const ws = new WebSocket(API.replace(/^http/, "ws") + "/ws");
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("websocket failed to open")), { once: true });
    });
    const client = new StompClient(ws);
    ws.send(frame("CONNECT", { "accept-version": "1.2", "heart-beat": "0,0", Authorization: `Bearer ${token}` }));
    const connected = await client.next(10_000);
    if (connected?.command !== "CONNECTED") throw new Error(`STOMP CONNECT refused: ${connected?.command ?? "no reply"}`);
    return client;
  }

  subscribe(destination: string): void {
    this.ws.send(frame("SUBSCRIBE", { id: `sub-${++this.subs}`, destination }));
  }

  send(destination: string, payload: unknown): void {
    this.ws.send(frame("SEND", { destination, "content-type": "application/json" }, JSON.stringify(payload)));
  }

  /** Next frame, or null when nothing arrives within {@code timeoutMs} (or the socket closed). */
  next(timeoutMs: number): Promise<Frame | null> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onFrame);
        resolve(null);
      }, timeoutMs);
      const onFrame = (f: Frame | null) => {
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push(onFrame);
    });
  }

  /** Next MESSAGE frame parsed as JSON, skipping anything else; null on timeout. */
  async nextMessage(timeoutMs: number): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const f = await this.next(remaining);
      if (!f) return null;
      if (f.command === "MESSAGE") return JSON.parse(f.body) as Record<string, unknown>;
    }
  }

  /** Every MESSAGE frame that arrives within {@code windowMs}, parsed as JSON. */
  async collect(windowMs: number): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const deadline = Date.now() + windowMs;
    for (;;) {
      const m = await this.nextMessage(Math.max(0, deadline - Date.now()));
      if (!m) return out;
      out.push(m);
    }
  }

  /** First MESSAGE frame matching {@code predicate}, ignoring unrelated traffic such as presence events. */
  async waitFor(predicate: (m: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown> | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = await this.nextMessage(Math.max(0, deadline - Date.now()));
      if (!m) return null;
      if (predicate(m)) return m;
    }
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

function frame(command: string, headers: Record<string, string>, body = ""): string {
  return `${command}\n${Object.entries(headers).map(([k, v]) => `${k}:${v}\n`).join("")}\n${body}\0`;
}

function parse(raw: string): Frame | null {
  if (raw === "" || raw === "\n") return null;
  const split = raw.indexOf("\n\n");
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split + 2);
  const [command, ...lines] = head.split("\n");
  if (!command) return null;
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const i = line.indexOf(":");
    if (i > 0) headers[line.slice(0, i)] = line.slice(i + 1);
  }
  return { command, headers, body };
}
