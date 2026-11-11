import {
  type Availability,
  type HistoryInput,
  type Latency,
  type LatencyBucket,
  MONITOR_RANGES,
  type MonitorInsights,
  type MonitorRange,
  type MonitorSummaryMetrics,
  type TimeSpan,
} from "./insight-types.ts";

const hourMs = 3_600_000;
const dayMs = MONITOR_RANGES["24h"].durationMs;
const dailySegments = 30;

type Sample = { at: number; responseMs: number };

function clip(span: TimeSpan, window: TimeSpan): TimeSpan {
  return {
    start: Math.max(span.start, window.start),
    end: Math.min(span.end, window.end),
  };
}

function mergeSpans(spans: TimeSpan[]): TimeSpan[] {
  const merged: TimeSpan[] = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    if (span.end <= span.start) continue;
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Both inputs are sorted and internally disjoint. */
function subtractSpans(spans: TimeSpan[], exclusions: TimeSpan[]): TimeSpan[] {
  const remaining: TimeSpan[] = [];
  let index = 0;
  for (const span of spans) {
    let start = span.start;
    while (index < exclusions.length && exclusions[index].end <= start) index += 1;
    while (index < exclusions.length && exclusions[index].start < span.end) {
      const exclusion = exclusions[index];
      if (exclusion.start > start) remaining.push({ start, end: exclusion.start });
      start = exclusion.end;
      if (start >= span.end) break;
      index += 1;
    }
    if (start < span.end) remaining.push({ start, end: span.end });
  }
  return remaining;
}

function pauseSpans(history: HistoryInput, timeline: TimeSpan): TimeSpan[] {
  const events = history.events
    .filter(({ at }) => +at <= timeline.end)
    .sort((a, b) => +a.at - +b.at);
  // An initial resume implies the monitor was already paused at the window start.
  // Legacy paused rows can have no transition events at all.
  let pausedAt = (events.length ? events[0].kind === "resumed" : history.isPaused)
    ? timeline.start
    : null;
  const spans: TimeSpan[] = [];
  for (const { at, kind } of events) {
    if (kind === "resumed") {
      if (pausedAt !== null) spans.push(clip({ start: pausedAt, end: +at }, timeline));
      pausedAt = null;
    } else {
      pausedAt ??= +at;
    }
  }
  if (pausedAt !== null) spans.push(clip({ start: pausedAt, end: timeline.end }, timeline));
  return mergeSpans(spans);
}

function gapSpans(times: number[], timeline: TimeSpan, pauses: TimeSpan[], staleMs: number) {
  if (!times.length) return [timeline];
  const gaps: TimeSpan[] = [{ start: timeline.start, end: times[0] }];
  for (let index = 1; index < times.length; index += 1) {
    if (times[index] - times[index - 1] > staleMs) {
      gaps.push({ start: times[index - 1], end: times[index] });
    }
  }

  // The latest check ages only until the next pause. Any resumed time after it
  // is unobserved until there is a check in that active period.
  let start = times[times.length - 1];
  let hasObservation = true;
  for (const pause of pauses) {
    if (pause.end <= start) continue;
    if (pause.start > start && (!hasObservation || pause.start - start >= staleMs)) {
      gaps.push({ start, end: pause.start });
    }
    start = pause.end;
    hasObservation = false;
  }
  if (!hasObservation || timeline.end - start >= staleMs) {
    gaps.push({ start, end: timeline.end });
  }
  return mergeSpans(gaps);
}

function prepareHistory(history: HistoryInput, timeline: TimeSpan) {
  const checks = history.checks
    .filter(({ checkedAt }) => +checkedAt >= +history.createdAt && +checkedAt <= timeline.end)
    .sort((a, b) => +a.checkedAt - +b.checkedAt);
  const incidents = history.incidents
    .map(({ startedAt, resolvedAt }) => clip({
      start: +startedAt,
      end: resolvedAt === null ? timeline.end : +resolvedAt,
    }, timeline))
    .filter(({ start, end }) => end > start);
  const confirmed = mergeSpans(incidents);
  const paused = pauseSpans(history, timeline);
  const gaps = gapSpans(checks.map(({ checkedAt }) => +checkedAt), timeline, paused,
    3 * history.intervalSeconds * 1000);
  const excluded = mergeSpans([...paused, ...subtractSpans(gaps, confirmed)]);
  const downtime = subtractSpans(confirmed, paused);
  const samples: Sample[] = [];
  for (const { checkedAt, ok, responseMs } of checks) {
    if (ok && responseMs !== null && +checkedAt >= timeline.start) {
      samples.push({ at: +checkedAt, responseMs });
    }
  }
  return { excluded, downtime, samples, incidents };
}

function durationInWindow(spans: TimeSpan[], window: TimeSpan): number {
  let duration = 0;
  for (const span of spans) {
    if (span.start >= window.end) break;
    const { start, end } = clip(span, window);
    duration += Math.max(0, end - start);
  }
  return duration;
}

function availabilityFor(
  { excluded, downtime }: ReturnType<typeof prepareHistory>,
  window: TimeSpan,
): Availability {
  const total = window.end - window.start;
  if (total <= 0) return { coverage: 0, percent: null };
  const observed = total - durationInWindow(excluded, window);
  const coverage = observed / total;
  const percent = coverage >= 0.5 && observed >= hourMs
    ? 100 * (1 - durationInWindow(downtime, window) / observed)
    : null;
  return { coverage, percent };
}

function average(samples: Sample[]): number | null {
  return samples.length
    ? samples.reduce((sum, { responseMs }) => sum + responseMs, 0) / samples.length
    : null;
}

function latencyFor(samples: Sample[]): Latency {
  if (!samples.length) return { averageMs: null, p95Ms: null, samples: 0 };
  const times = samples.map(({ responseMs }) => responseMs).sort((a, b) => a - b);
  const index = (times.length - 1) * 0.95;
  const lower = Math.floor(index);
  const p95Ms = times[lower] + (times[Math.ceil(index)] - times[lower]) * (index - lower);
  return { averageMs: average(samples), p95Ms, samples: samples.length };
}

function bucketLatency(samples: Sample[], window: TimeSpan, bucketMs: number): LatencyBucket[] {
  if (window.end <= window.start) return [];
  const buckets: LatencyBucket[] = [];
  let offset = 0;
  for (let at = Math.floor(window.start / bucketMs) * bucketMs; at < window.end; at += bucketMs) {
    const bucket = clip({ start: at, end: at + bucketMs }, window);
    const first = offset;
    while (
      offset < samples.length &&
      (samples[offset].at < bucket.end || bucket.end === window.end)
    ) {
      offset += 1;
    }
    buckets.push({ ...bucket, ...latencyFor(samples.slice(first, offset)) });
  }
  return buckets;
}

function windowFrom(createdAt: number, start: number, end: number): TimeSpan {
  return { start: Math.min(Math.max(createdAt, start), end), end };
}

export function summarizeMonitor(history: HistoryInput, now: Date): MonitorSummaryMetrics {
  const window = windowFrom(+history.createdAt, +now - dayMs, +now);
  const prepared = prepareHistory(history, window);
  return {
    availability: availabilityFor(prepared, window),
    averageMs: average(prepared.samples),
  };
}

export function buildMonitorInsights(
  history: HistoryInput,
  range: MonitorRange,
  now: Date,
): MonitorInsights {
  const { durationMs, bucketMs } = MONITOR_RANGES[range];
  const window = windowFrom(+history.createdAt, +now - durationMs, +now);
  const today = Math.floor(+now / dayMs) * dayMs;
  const firstDay = today - (dailySegments - 1) * dayMs;
  const timeline = windowFrom(+history.createdAt, Math.min(window.start, firstDay), +now);
  const prepared = prepareHistory(history, timeline);
  const samples = prepared.samples.filter(({ at }) => at >= window.start);
  const days = Array.from({ length: dailySegments }, (_, index) => {
    const start = firstDay + index * dayMs;
    const day = windowFrom(+history.createdAt, start, Math.min(start + dayMs, +now));
    const incidentCount = day.start < day.end
      ? prepared.incidents.filter((span) => span.start < day.end && span.end > day.start).length
      : 0;
    return { ...availabilityFor(prepared, day), start, incidentCount };
  });
  return {
    window,
    availability: availabilityFor(prepared, window),
    latency: latencyFor(samples),
    buckets: bucketLatency(samples, window, bucketMs),
    incidentBands: prepared.downtime.map((span) => clip(span, window)).filter(
      ({ start, end }) => start < end,
    ),
    days,
  };
}
