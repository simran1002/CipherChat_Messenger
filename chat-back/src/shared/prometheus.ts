/**
 * Prometheus metrics (per-process; a scraper aggregates across replicas).
 * Lives alongside MetricsCollector: the collector feeds the in-app JSON
 * dashboard, prom-client feeds /metrics for operators. Both are content-free —
 * counts and latencies only, never message data.
 */
import client from "prom-client";

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const messageLatency = new client.Histogram({
  name: "cipherchat_message_latency_ms",
  help: "End-to-end message handling latency (socket receive → broadcast) in ms",
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500],
  registers: [registry],
});

export const messagesTotal = new client.Counter({
  name: "cipherchat_messages_total",
  help: "Messages processed, labelled by outcome",
  labelNames: ["outcome"] as const, // sent | failed | duplicate | rate_limited
  registers: [registry],
});

export const socketsConnected = new client.Gauge({
  name: "cipherchat_sockets_connected",
  help: "Currently connected sockets on this replica",
  registers: [registry],
});
