/**
 * In-process metrics for real-time analytics.
 * Tracks message latency (p50/p99), delivery rates, and concurrency.
 * Production: emit to Kafka → ClickHouse / expose as Prometheus endpoint.
 */
class MetricsCollector {
  constructor() {
    this.reset();
    // Snapshot every minute
    setInterval(() => this._snapshot(), 60_000);
  }

  reset() {
    this.messageSent = 0;
    this.messageDelivered = 0;
    this.messageFailed = 0;
    this.duplicatesRejected = 0;
    this.rateLimitHits = 0;
    this.latencies = []; // ms array, capped at 10k samples
    this.peakConcurrent = 0;
    this.currentConcurrent = 0;
    this.snapshots = []; // last 60 snapshots (1 hour rolling)
  }

  recordSent() { this.messageSent++; }
  recordDelivered() { this.messageDelivered++; }
  recordFailed() { this.messageFailed++; }
  recordDuplicate() { this.duplicatesRejected++; }
  recordRateLimit() { this.rateLimitHits++; }

  recordLatency(ms) {
    if (this.latencies.length >= 10_000) this.latencies.shift();
    this.latencies.push(ms);
  }

  userConnected() {
    this.currentConcurrent++;
    if (this.currentConcurrent > this.peakConcurrent) {
      this.peakConcurrent = this.currentConcurrent;
    }
  }

  userDisconnected() {
    this.currentConcurrent = Math.max(0, this.currentConcurrent - 1);
  }

  percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  summary() {
    const deliveryRate = this.messageSent > 0
      ? ((this.messageDelivered / this.messageSent) * 100).toFixed(1)
      : "100.0";
    return {
      messageSent: this.messageSent,
      messageDelivered: this.messageDelivered,
      messageFailed: this.messageFailed,
      duplicatesRejected: this.duplicatesRejected,
      rateLimitHits: this.rateLimitHits,
      deliveryRatePct: parseFloat(deliveryRate),
      latency: {
        p50: this.percentile(this.latencies, 50),
        p95: this.percentile(this.latencies, 95),
        p99: this.percentile(this.latencies, 99),
        samples: this.latencies.length,
      },
      concurrency: {
        current: this.currentConcurrent,
        peak: this.peakConcurrent,
      },
      snapshots: this.snapshots.slice(-10), // last 10 min
    };
  }

  _snapshot() {
    this.snapshots.push({ ts: Date.now(), ...this.summary() });
    if (this.snapshots.length > 60) this.snapshots.shift();
  }
}

module.exports = new MetricsCollector();
