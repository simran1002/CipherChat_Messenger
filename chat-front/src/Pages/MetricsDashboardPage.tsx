/**
 * Live system metrics dashboard — polls GET /api/v1/analytics/metrics every 5s.
 */
import { useState, useEffect, useCallback } from "react";
import {
  ChartBarIcon,
  PaperAirplaneIcon,
  CheckCircleIcon,
  XCircleIcon,
  DocumentDuplicateIcon,
  BoltSlashIcon,
  UsersIcon,
  ArrowTrendingUpIcon,
  ClockIcon,
} from "@heroicons/react/24/outline";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import api from "../services/api";
import { makeToast } from "../utils/toast";

interface LatencyStats {
  p50: number;
  p95: number;
  p99: number;
  samples: number;
}

interface MetricsSnapshot {
  ts: number;
  messageSent: number;
  messageDelivered: number;
  messageFailed: number;
  duplicatesRejected: number;
  rateLimitHits: number;
  deliveryRatePct: number;
  latency: LatencyStats;
  concurrency: { current: number; peak: number };
}

interface MetricsSummary extends Omit<MetricsSnapshot, "ts"> {
  snapshots: MetricsSnapshot[];
}

const POLL_INTERVAL_MS = 5_000;

const GRID_STROKE = "#374151"; // gray-700
const AXIS_STROKE = "#6b7280"; // gray-500
const TOOLTIP_STYLE = {
  backgroundColor: "#1f2937", // gray-800
  border: "1px solid #374151",
  borderRadius: "0.75rem",
  color: "#e5e7eb",
  fontSize: "0.75rem",
} as const;

function formatTs(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatCard({
  icon: Icon,
  label,
  value,
  accent = "text-violet-400",
}: {
  icon: typeof ChartBarIcon;
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-2xl p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-xl bg-gray-700/50 flex items-center justify-center shrink-0">
        <Icon className={`w-5 h-5 ${accent}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xl font-bold text-white truncate">{value}</p>
        <p className="text-xs text-gray-500 truncate">{label}</p>
      </div>
    </div>
  );
}

const MetricsDashboardPage = () => {
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [error, setError] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await api.get("/api/v1/analytics/metrics");
      setMetrics(res.data as MetricsSummary);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => {
    void fetchMetrics();
    const id = setInterval(() => void fetchMetrics(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchMetrics]);

  // Toast only while nothing has ever loaded — after that the inline banner covers it
  useEffect(() => {
    if (error && !metrics) makeToast("error", "Failed to load metrics");
  }, [error, metrics]);

  const chartData = (metrics?.snapshots ?? []).map((s) => ({
    time: formatTs(s.ts),
    p95: s.latency.p95,
    deliveryRatePct: s.deliveryRatePct,
  }));

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900">
      <div className="bg-gray-800/50 backdrop-blur-sm border-b border-gray-700/50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-violet-500 to-purple-700 flex items-center justify-center shadow-lg">
              <ChartBarIcon className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white">
                System Metrics — live from /api/v1/analytics/metrics
              </h1>
              <p className="text-gray-400 mt-0.5 text-sm flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${error ? "bg-red-500" : "bg-green-500 animate-pulse"}`} />
                {error ? "Connection lost — retrying…" : `Refreshes every ${POLL_INTERVAL_MS / 1000}s`}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {!metrics ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-12 h-12 border-4 border-violet-400 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-8">
            {/* Delivery stat cards */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Delivery</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <StatCard icon={ArrowTrendingUpIcon} label="Delivery rate" value={`${metrics.deliveryRatePct}%`} accent="text-green-400" />
                <StatCard icon={PaperAirplaneIcon} label="Messages sent" value={metrics.messageSent} />
                <StatCard icon={CheckCircleIcon} label="Messages delivered" value={metrics.messageDelivered} accent="text-sky-400" />
                <StatCard icon={XCircleIcon} label="Messages failed" value={metrics.messageFailed} accent="text-red-400" />
                <StatCard icon={DocumentDuplicateIcon} label="Duplicates rejected" value={metrics.duplicatesRejected} accent="text-amber-400" />
                <StatCard icon={BoltSlashIcon} label="Rate-limit hits" value={metrics.rateLimitHits} accent="text-orange-400" />
                <StatCard icon={UsersIcon} label="Current concurrency" value={metrics.concurrency.current} accent="text-teal-400" />
                <StatCard icon={UsersIcon} label="Peak concurrency" value={metrics.concurrency.peak} accent="text-indigo-400" />
              </div>
            </section>

            {/* Latency */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
                Latency <span className="normal-case font-normal text-gray-600">({metrics.latency.samples} samples)</span>
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                <StatCard icon={ClockIcon} label="p50 latency" value={`${metrics.latency.p50} ms`} accent="text-green-400" />
                <StatCard icon={ClockIcon} label="p95 latency" value={`${metrics.latency.p95} ms`} accent="text-amber-400" />
                <StatCard icon={ClockIcon} label="p99 latency" value={`${metrics.latency.p99} ms`} accent="text-red-400" />
              </div>
              <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-2xl p-5">
                <h3 className="text-sm font-medium text-gray-300 mb-4">p95 latency over time (ms)</h3>
                {chartData.length === 0 ? (
                  <p className="text-sm text-gray-500 py-10 text-center">No snapshots yet — data appears after the first minute.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                      <XAxis dataKey="time" stroke={AXIS_STROKE} tick={{ fill: AXIS_STROKE, fontSize: 11 }} />
                      <YAxis stroke={AXIS_STROKE} tick={{ fill: AXIS_STROKE, fontSize: 11 }} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#9ca3af" }} />
                      <Line
                        type="monotone"
                        dataKey="p95"
                        name="p95 (ms)"
                        stroke="#a78bfa"
                        strokeWidth={2}
                        dot={{ r: 3, fill: "#a78bfa" }}
                        activeDot={{ r: 5 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>

            {/* Delivery rate over time */}
            <section>
              <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Delivery rate over time</h2>
              <div className="bg-gray-800/50 backdrop-blur-sm border border-gray-700/50 rounded-2xl p-5">
                <h3 className="text-sm font-medium text-gray-300 mb-4">Delivery rate (%)</h3>
                {chartData.length === 0 ? (
                  <p className="text-sm text-gray-500 py-10 text-center">No snapshots yet — data appears after the first minute.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                      <defs>
                        <linearGradient id="deliveryRateFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#34d399" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#34d399" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" />
                      <XAxis dataKey="time" stroke={AXIS_STROKE} tick={{ fill: AXIS_STROKE, fontSize: 11 }} />
                      <YAxis domain={[0, 100]} stroke={AXIS_STROKE} tick={{ fill: AXIS_STROKE, fontSize: 11 }} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: "#9ca3af" }} />
                      <Area
                        type="monotone"
                        dataKey="deliveryRatePct"
                        name="Delivery rate (%)"
                        stroke="#34d399"
                        strokeWidth={2}
                        fill="url(#deliveryRateFill)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
};

export default MetricsDashboardPage;
