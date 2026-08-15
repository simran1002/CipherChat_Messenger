/**
 * In-process metrics for real-time analytics.
 * Tracks message latency (p50/p95/p99), delivery rates, and concurrency.
 * Phase 2: replaced by prom-client histograms behind the same summary() shape.
 */

export interface MetricsSummary {
  messageSent: number;
  messageDelivered: number;
  messageFailed: number;
  duplicatesRejected: number;
  rateLimitHits: number;
  deliveryRatePct: number;
  latency: { p50: number; p95: number; p99: number; samples: number };
  concurrency: { current: number; peak: number };
  snapshots: Array<{ ts: number } & Omit<MetricsSummary, "snapshots">>;
}

const MAX_LATENCY_SAMPLES = 10_000;
const MAX_SNAPSHOTS = 60;

export class MetricsCollector {
  private messageSent = 0;
  private messageDelivered = 0;
  private messageFailed = 0;
  private duplicatesRejected = 0;
  private rateLimitHits = 0;
  private latencies: number[] = [];
  private latencyStart = 0; // ring-buffer head — avoids O(n) Array.shift at cap
  private peakConcurrent = 0;
  private currentConcurrent = 0;
  private snapshots: MetricsSummary["snapshots"] = [];
  private readonly snapshotTimer: NodeJS.Timeout;

  constructor(snapshotIntervalMs = 60_000) {
    this.snapshotTimer = setInterval(() => this.snapshot(), snapshotIntervalMs);
    this.snapshotTimer.unref();
  }

  reset(): void {
    this.messageSent = 0;
    this.messageDelivered = 0;
    this.messageFailed = 0;
    this.duplicatesRejected = 0;
    this.rateLimitHits = 0;
    this.latencies = [];
    this.latencyStart = 0;
    this.peakConcurrent = 0;
    this.currentConcurrent = 0;
    this.snapshots = [];
  }

  stop(): void {
    clearInterval(this.snapshotTimer);
  }

  recordSent(): void {
    this.messageSent++;
  }
  recordDelivered(): void {
    this.messageDelivered++;
  }
  recordFailed(): void {
    this.messageFailed++;
  }
  recordDuplicate(): void {
    this.duplicatesRejected++;
  }
  recordRateLimit(): void {
    this.rateLimitHits++;
  }

  recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length - this.latencyStart > MAX_LATENCY_SAMPLES) {
      this.latencyStart++;
      // Compact occasionally so the array doesn't grow unbounded
      if (this.latencyStart > MAX_LATENCY_SAMPLES) {
        this.latencies = this.latencies.slice(this.latencyStart);
        this.latencyStart = 0;
      }
    }
  }

  userConnected(): void {
    this.currentConcurrent++;
    if (this.currentConcurrent > this.peakConcurrent) {
      this.peakConcurrent = this.currentConcurrent;
    }
  }

  userDisconnected(): void {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
  }

  percentile(arr: readonly number[], p: number): number {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)] ?? 0;
  }

  summary(): MetricsSummary {
    const samples = this.latencies.slice(this.latencyStart);
    const deliveryRate =
      this.messageSent > 0 ? (this.messageDelivered / this.messageSent) * 100 : 100;
    return {
      messageSent: this.messageSent,
      messageDelivered: this.messageDelivered,
      messageFailed: this.messageFailed,
      duplicatesRejected: this.duplicatesRejected,
      rateLimitHits: this.rateLimitHits,
      deliveryRatePct: parseFloat(deliveryRate.toFixed(1)),
      latency: {
        p50: this.percentile(samples, 50),
        p95: this.percentile(samples, 95),
        p99: this.percentile(samples, 99),
        samples: samples.length,
      },
      concurrency: { current: this.currentConcurrent, peak: this.peakConcurrent },
      snapshots: this.snapshots.slice(-10), // last 10 min
    };
  }

  private snapshot(): void {
    const { snapshots: _omit, ...rest } = this.summary();
    this.snapshots.push({ ts: Date.now(), ...rest });
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  }
}
