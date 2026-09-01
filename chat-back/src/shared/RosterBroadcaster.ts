/**
 * Throttles roster broadcasts: fire immediately when idle (small rooms stay
 * snappy), coalesce everything that arrives during the cooldown into ONE
 * trailing broadcast.
 *
 * Why it exists: the roster used to be re-broadcast to every socket on every
 * connect/disconnect/presence change. During a ramp to N connections that is
 * Σk² ≈ N³/3 payload-entries on the wire — the binding constraint the
 * connection-density benchmark (scripts/connflood.mts) exposed long before
 * memory or CPU did. With throttling, churn costs one broadcast per interval
 * regardless of rate.
 */
export class RosterBroadcaster {
  private timer: NodeJS.Timeout | null = null;
  // Synchronous guard: the cooldown timer only exists AFTER the async send
  // resolves, so without this flag a same-tick burst of requests would all
  // see "idle" and fan out one send each (the unit test proves it).
  private inFlight = false;
  private dirty = false;
  private disposed = false;

  constructor(
    private readonly send: () => Promise<void>,
    private readonly intervalMs = 1000
  ) {}

  /** Request a broadcast — immediate when idle, coalesced during cooldown. */
  request(): void {
    if (this.timer || this.inFlight) {
      this.dirty = true;
      return;
    }
    this.inFlight = true;
    void this.fire();
  }

  private async fire(): Promise<void> {
    this.dirty = false;
    try {
      await this.send();
    } catch {
      /* caller's emit path logs its own failures */
    }
    this.inFlight = false;
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.dirty) this.request();
    }, this.intervalMs);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.dirty = false;
    this.disposed = true;
  }
}
