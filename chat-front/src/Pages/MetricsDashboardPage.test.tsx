import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import MetricsDashboardPage from "./MetricsDashboardPage";
import api from "../services/api";
import { makeToast } from "../utils/toast";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  getApiUrl: () => "http://localhost:8000",
}));

vi.mock("../utils/toast", () => ({ makeToast: vi.fn() }));

// recharts measures its ResponsiveContainer with ResizeObserver/layout, which
// jsdom doesn't provide — it would render an empty 0x0 chart. Stub every used
// export with a tagged element (charts expose their data length) so the test
// can assert that the page wires snapshots into the charts.
vi.mock("recharts", async () => {
  const React = await import("react");
  type StubProps = { children?: React.ReactNode; data?: unknown[] };
  const stub = (name: string, tag: "div" | "svg" | "g") => {
    const Stub = (props: StubProps) =>
      React.createElement(
        tag,
        {
          "data-testid": `recharts-${name}`,
          "data-points": Array.isArray(props.data) ? String(props.data.length) : undefined,
        },
        props.children
      );
    Stub.displayName = name;
    return Stub;
  };
  return {
    ResponsiveContainer: stub("ResponsiveContainer", "div"),
    LineChart: stub("LineChart", "svg"),
    AreaChart: stub("AreaChart", "svg"),
    Line: stub("Line", "g"),
    Area: stub("Area", "g"),
    XAxis: stub("XAxis", "g"),
    YAxis: stub("YAxis", "g"),
    CartesianGrid: stub("CartesianGrid", "g"),
    Tooltip: stub("Tooltip", "g"),
  };
});

type ApiFn = (url: string) => Promise<{ data: unknown }>;
const getMock = api.get as unknown as Mock<ApiFn>;
const toastMock = vi.mocked(makeToast);

const T0 = Date.UTC(2026, 7, 23, 10, 0, 0);

function snapshot(offsetMin: number, p95: number, deliveryRatePct: number) {
  return {
    ts: T0 + offsetMin * 60_000,
    messageSent: 100,
    messageDelivered: 99,
    messageFailed: 1,
    duplicatesRejected: 0,
    rateLimitHits: 0,
    deliveryRatePct,
    latency: { p50: 40, p95, p99: 200, samples: 100 },
    concurrency: { current: 10, peak: 20 },
  };
}

const PAYLOAD = {
  messageSent: 1200,
  messageDelivered: 1188,
  messageFailed: 12,
  duplicatesRejected: 7,
  rateLimitHits: 3,
  deliveryRatePct: 99,
  latency: { p50: 42, p95: 120, p99: 310, samples: 950 },
  concurrency: { current: 17, peak: 54 },
  snapshots: [snapshot(0, 110, 98.5), snapshot(1, 120, 99), snapshot(2, 125, 99.2)],
};

/** Each StatCard is `<p>{value}</p><p>{label}</p>` — assert the pair together. */
function expectStat(label: string, value: string) {
  const labelEl = screen.getByText(label);
  const valueEl = labelEl.previousElementSibling;
  expect(valueEl).not.toBeNull();
  expect(valueEl).toHaveTextContent(value);
}

describe("MetricsDashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches /analytics/metrics on mount and renders every stat card from the payload", async () => {
    getMock.mockResolvedValue({ data: PAYLOAD });
    render(<MetricsDashboardPage />);

    // Spinner until the first payload lands
    expect(screen.queryByText("Delivery rate")).not.toBeInTheDocument();
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledWith("/analytics/metrics");

    await screen.findByText("Delivery rate");

    expectStat("Delivery rate", "99%");
    expectStat("Messages sent", "1200");
    expectStat("Messages delivered", "1188");
    expectStat("Messages failed", "12");
    expectStat("Duplicates rejected", "7");
    expectStat("Rate-limit hits", "3");
    expectStat("Current concurrency", "17");
    expectStat("Peak concurrency", "54");
    expectStat("p50 latency", "42 ms");
    expectStat("p95 latency", "120 ms");
    expectStat("p99 latency", "310 ms");
    expect(screen.getByText("(950 samples)")).toBeInTheDocument();

    // Header status line
    expect(screen.getByText("Refreshes every 5s")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("System Metrics");
    expect(toastMock).not.toHaveBeenCalled();
  });

  it("feeds the snapshots into both charts", async () => {
    getMock.mockResolvedValue({ data: PAYLOAD });
    render(<MetricsDashboardPage />);
    await screen.findByText("Delivery rate");

    expect(screen.getByTestId("recharts-LineChart")).toHaveAttribute("data-points", "3");
    expect(screen.getByTestId("recharts-AreaChart")).toHaveAttribute("data-points", "3");
    expect(screen.getAllByTestId("recharts-ResponsiveContainer")).toHaveLength(2);
    expect(screen.getByTestId("recharts-Line")).toBeInTheDocument();
    expect(screen.getByTestId("recharts-Area")).toBeInTheDocument();
    expect(screen.queryByText(/no snapshots yet/i)).not.toBeInTheDocument();
  });

  it("shows the empty-state copy instead of charts when there are no snapshots", async () => {
    getMock.mockResolvedValue({ data: { ...PAYLOAD, snapshots: [] } });
    render(<MetricsDashboardPage />);
    await screen.findByText("Delivery rate");

    expect(screen.getAllByText(/no snapshots yet — data appears after the first minute/i)).toHaveLength(2);
    expect(screen.queryByTestId("recharts-LineChart")).not.toBeInTheDocument();
    expect(screen.queryByTestId("recharts-AreaChart")).not.toBeInTheDocument();
  });

  it("polls every 5s and stops polling on unmount", async () => {
    vi.useFakeTimers();
    getMock.mockResolvedValue({ data: PAYLOAD });
    const { unmount } = render(<MetricsDashboardPage />);

    expect(getMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(getMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(getMock).toHaveBeenCalledTimes(3);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it("re-renders with the newest payload after a poll", async () => {
    vi.useFakeTimers();
    getMock
      .mockResolvedValueOnce({ data: PAYLOAD })
      .mockResolvedValueOnce({ data: { ...PAYLOAD, messageSent: 1500, concurrency: { current: 99, peak: 120 } } });
    render(<MetricsDashboardPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expectStat("Messages sent", "1200");
    expectStat("Peak concurrency", "54");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expectStat("Messages sent", "1500");
    expectStat("Current concurrency", "99");
    expectStat("Peak concurrency", "120");
  });

  it("first-load failure toasts once and shows the connection-lost banner; recovery clears it", async () => {
    vi.useFakeTimers();
    getMock.mockRejectedValueOnce(new Error("ECONNREFUSED")).mockResolvedValue({ data: PAYLOAD });
    render(<MetricsDashboardPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(toastMock).toHaveBeenCalledTimes(1);
    expect(toastMock).toHaveBeenCalledWith("error", "Failed to load metrics");
    expect(screen.getByText("Connection lost — retrying…")).toBeInTheDocument();
    expect(screen.queryByText("Delivery rate")).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("Refreshes every 5s")).toBeInTheDocument();
    expectStat("Delivery rate", "99%");
    expect(toastMock).toHaveBeenCalledTimes(1);
  });

  it("a failure AFTER data has loaded keeps the stale data, flips the banner, and does not toast", async () => {
    vi.useFakeTimers();
    getMock.mockResolvedValueOnce({ data: PAYLOAD }).mockRejectedValueOnce(new Error("timeout"));
    render(<MetricsDashboardPage />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expectStat("Messages sent", "1200");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(screen.getByText("Connection lost — retrying…")).toBeInTheDocument();
    expectStat("Messages sent", "1200"); // stale data retained
    expect(toastMock).not.toHaveBeenCalled();
  });
});
