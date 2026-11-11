export const MONITOR_RANGES = {
  "24h": { label: "24 h", durationMs: 86_400_000, bucketMs: 900_000 },
  "7d": { label: "7 d", durationMs: 604_800_000, bucketMs: 3_600_000 },
  "30d": { label: "30 d", durationMs: 2_592_000_000, bucketMs: 21_600_000 },
} as const;

export type MonitorRange = keyof typeof MONITOR_RANGES;

export type TimeSpan = { start: number; end: number };

export type Availability = {
  percent: number | null;
  coverage: number;
};

export type Latency = {
  averageMs: number | null;
  p95Ms: number | null;
  samples: number;
};

export type MonitorSummaryMetrics = {
  availability: Availability;
  averageMs: number | null;
};

export type LatencyBucket = Latency & TimeSpan;

export type AvailabilityDay = Availability & { start: number; incidentCount: number };

export type MonitorInsights = {
  window: TimeSpan;
  availability: Availability;
  latency: Latency;
  buckets: LatencyBucket[];
  incidentBands: TimeSpan[];
  days: AvailabilityDay[];
};

export type HistoryInput = {
  createdAt: Date;
  intervalSeconds: number;
  isPaused: boolean;
  checks: { checkedAt: Date; ok: boolean; responseMs: number | null }[];
  events: { at: Date; kind: "paused" | "resumed" | "blocked" }[];
  incidents: { startedAt: Date; resolvedAt: Date | null }[];
};
