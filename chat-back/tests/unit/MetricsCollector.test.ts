import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetricsCollector } from "../../src/shared/MetricsCollector.js";

describe("MetricsCollector (in-process metrics)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("tracks all counters in summary()", () => {
    const m = new MetricsCollector(60_000);
    m.recordSent();
    m.recordSent();
    m.recordSent();
    m.recordDelivered();
    m.recordDelivered();
    m.recordFailed();
    m.recordDuplicate();
    m.recordRateLimit();

    const s = m.summary();
    expect(s.messageSent).toBe(3);
    expect(s.messageDelivered).toBe(2);
    expect(s.messageFailed).toBe(1);
    expect(s.duplicatesRejected).toBe(1);
    expect(s.rateLimitHits).toBe(1);
    m.stop();
  });

  it("tracks current and peak concurrency, never below zero", () => {
    const m = new MetricsCollector(60_000);
    m.userConnected();
    m.userConnected();
    m.userConnected();
    m.userDisconnected();
    expect(m.summary().concurrency).toEqual({ current: 2, peak: 3 });

    m.userDisconnected();
    m.userDisconnected();
    m.userDisconnected(); // extra disconnect must not go negative
    expect(m.summary().concurrency).toEqual({ current: 0, peak: 3 });
    m.stop();
  });

  describe("percentile()", () => {
    it("returns 0 for an empty array", () => {
      const m = new MetricsCollector(60_000);
      expect(m.percentile([], 50)).toBe(0);
      expect(m.percentile([], 99)).toBe(0);
      m.stop();
    });

    it("returns the single element for any percentile", () => {
      const m = new MetricsCollector(60_000);
      expect(m.percentile([42], 1)).toBe(42);
      expect(m.percentile([42], 50)).toBe(42);
      expect(m.percentile([42], 99)).toBe(42);
      m.stop();
    });

    it("computes p50/p95/p99 on a known 100-element array", () => {
      const m = new MetricsCollector(60_000);
      // 1..100 shuffled — percentile() must sort internally
      const values = Array.from({ length: 100 }, (_, i) => i + 1);
      for (let i = values.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [values[i], values[j]] = [values[j]!, values[i]!];
      }
      expect(m.percentile(values, 50)).toBe(50);
      expect(m.percentile(values, 95)).toBe(95);
      expect(m.percentile(values, 99)).toBe(99);
      m.stop();
    });
  });

  it("computes deliveryRatePct as delivered/sent (100 when nothing sent)", () => {
    const fresh = new MetricsCollector(60_000);
    expect(fresh.summary().deliveryRatePct).toBe(100); // no divide-by-zero
    fresh.stop();

    const m = new MetricsCollector(60_000);
    m.recordSent();
    m.recordSent();
    m.recordSent();
    m.recordDelivered();
    m.recordDelivered();
    expect(m.summary().deliveryRatePct).toBe(66.7); // (2/3)*100 → 1 decimal
    m.stop();
  });

  it("caps latency samples at 10000 (ring buffer, including compaction)", () => {
    const m = new MetricsCollector(60_000);
    // 25000 pushes crosses both the cap and the internal compaction point
    for (let i = 0; i < 25_000; i++) m.recordLatency(i);

    const { latency } = m.summary();
    expect(latency.samples).toBe(10_000);
    // Window holds the most recent 10000 values: 15000..24999
    expect(latency.p50).toBeGreaterThanOrEqual(15_000);
    m.stop();
  });

  it("takes snapshots on the interval and stop() halts them", () => {
    const m = new MetricsCollector(1000);
    m.recordSent();

    vi.advanceTimersByTime(1000);
    expect(m.summary().snapshots).toHaveLength(1);
    expect(m.summary().snapshots[0]?.messageSent).toBe(1);

    m.stop();
    vi.advanceTimersByTime(5000);
    expect(m.summary().snapshots).toHaveLength(1); // no new snapshots after stop
  });
});
