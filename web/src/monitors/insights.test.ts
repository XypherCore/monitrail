import { describe, expect, it } from "vitest";
import type { HistoryInput } from "./insight-types.ts";
import { buildMonitorInsights, summarizeMonitor } from "./insights.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const now = new Date("2026-11-12T00:00:00.000Z");
const start = +now - 30 * day;

function check(at: number, responseMs: number | null = 100, ok = true) {
  return { checkedAt: new Date(at), responseMs, ok };
}

function checksBetween(first: number, last: number, step = 5 * minute) {
  const checks: HistoryInput["checks"] = [];
  for (let at = first; at <= last; at += step) checks.push(check(at));
  return checks;
}

function history(input: Partial<HistoryInput> = {}): HistoryInput {
  return {
    createdAt: new Date(start),
    intervalSeconds: 300,
    isPaused: false,
    checks: [],
    events: [],
    incidents: [],
    ...input,
  };
}

const incident = (first: number, last: number | null) => ({
  startedAt: new Date(first),
  resolvedAt: last === null ? null : new Date(last),
});
const pause = (at: number, kind: HistoryInput["events"][number]["kind"] = "paused") => ({
  at: new Date(at),
  kind,
});

describe("documented availability examples", () => {
  const failure = start + 15 * day;
  const recovery = failure + 15 * minute;
  const outage = incident(failure, recovery);
  const observations = (first: number, last: number) =>
    checksBetween(first, last).map((sample) =>
      +sample.checkedAt >= failure && +sample.checkedAt < recovery
        ? { ...sample, ok: false }
        : sample,
    );

  it("measures a 15-minute outage over 30 fully observed days", () => {
    const result = buildMonitorInsights(
      history({ checks: observations(start, +now), incidents: [outage] }),
      "30d",
      now,
    );
    expect(result.availability.percent?.toFixed(3)).toBe("99.965");
    expect(result.availability.coverage).toBe(1);
  });

  it("excludes ten paused days from the same incident's denominator", () => {
    const pausedAt = start + 2 * day;
    const resumedAt = pausedAt + 10 * day;
    const result = buildMonitorInsights(
      history({
        checks: [...observations(start, pausedAt), ...observations(resumedAt, +now)],
        events: [pause(pausedAt), pause(resumedAt, "resumed")],
        incidents: [outage],
      }),
      "30d",
      now,
    );
    expect(result.availability.percent?.toFixed(3)).toBe("99.948");
    expect((100 * result.availability.coverage).toFixed(1)).toBe("66.7");
  });

  it("excludes an ongoing two-day checker outage with no confirmed incident", () => {
    const result = buildMonitorInsights(
      history({ checks: checksBetween(start, +now - 2 * day) }),
      "30d",
      now,
    );
    expect(result.availability.percent).toBe(100);
    expect((100 * result.availability.coverage).toFixed(1)).toBe("93.3");
  });

  it("withholds availability after an ongoing twenty-day checker outage", () => {
    const result = buildMonitorInsights(
      history({ checks: checksBetween(start, +now - 20 * day) }),
      "30d",
      now,
    );
    expect(result.availability.percent).toBeNull();
    expect((100 * result.availability.coverage).toFixed(1)).toBe("33.3");
  });
});

describe("coverage and downtime boundaries", () => {
  it("clips to creation and withholds an empty window or one with less than one observed hour", () => {
    const createdAt = +now - 55 * minute;
    const short = history({
      createdAt: new Date(createdAt),
      checks: checksBetween(createdAt, +now),
    });
    expect(summarizeMonitor(short, now).availability).toEqual({ percent: null, coverage: 1 });
    expect(summarizeMonitor(history(), now).availability).toEqual({ percent: null, coverage: 0 });
    const justCreated = buildMonitorInsights(history({ createdAt: now }), "24h", now);
    expect(justCreated.window).toEqual({ start: +now, end: +now });
    expect(justCreated.availability).toEqual({ percent: null, coverage: 0 });
  });

  it("accepts exactly 50% coverage and one hour of observed time", () => {
    const createdAt = +now - 2 * hour;
    const data = history({
      createdAt: new Date(createdAt),
      checks: checksBetween(createdAt, +now - hour),
    });
    expect(summarizeMonitor(data, now).availability).toEqual({ percent: 100, coverage: 0.5 });
  });

  it("uses the predecessor to bridge a window boundary without including its latency", () => {
    const from = +now - day;
    const data = history({
      checks: [check(from - 4 * minute, 1000), ...checksBetween(from + 4 * minute, +now)],
    });
    expect(summarizeMonitor(data, now)).toEqual({
      availability: { percent: 100, coverage: 1 },
      averageMs: 100,
    });
    data.checks.shift();
    expect(summarizeMonitor(data, now).availability.coverage).toBeCloseTo(1436 / 1440);
  });

  it("keeps interior gaps at exactly 3× observed and excludes a trailing gap at the same age", () => {
    const from = +now - 2 * hour;
    const data = history({
      createdAt: new Date(from),
      checks: [
        ...checksBetween(from, from + hour),
        ...checksBetween(from + hour + 15 * minute, +now - 15 * minute),
      ],
    });
    expect(summarizeMonitor(data, now).availability).toEqual({ percent: 100, coverage: 105 / 120 });
    data.checks.splice(12, 1);
    expect(summarizeMonitor(data, now).availability).toEqual({ percent: 100, coverage: 85 / 120 });
  });

  it("counts incident time during stale gaps, with pauses taking precedence", () => {
    const from = +now - 3 * hour;
    const data = history({
      createdAt: new Date(from),
      checks: checksBetween(from, from + hour),
      events: [pause(from + 2 * hour + 30 * minute, "blocked")],
      incidents: [
        incident(from + 90 * minute, from + 140 * minute),
        incident(from + 110 * minute, null),
      ],
      isPaused: true,
    });
    // 60 minutes checked and 60 incident minutes after that, outside the blocked span.
    const result = buildMonitorInsights(data, "24h", now);
    expect(result.availability).toEqual({ percent: 50, coverage: 2 / 3 });
    expect(result.incidentBands).toEqual([
      { start: from + 90 * minute, end: from + 150 * minute },
    ]);
  });

  it("handles an initial resume and a legacy paused monitor with no events", () => {
    const from = +now - 4 * hour;
    const resume = from + 2 * hour;
    const data = history({
      createdAt: new Date(from),
      checks: checksBetween(resume, +now),
      events: [pause(resume, "resumed")],
    });
    expect(summarizeMonitor(data, now).availability).toEqual({ percent: 100, coverage: 0.5 });
    expect(summarizeMonitor({ ...data, events: [], isPaused: true }, now).availability)
      .toEqual({ percent: null, coverage: 0 });
  });

  it("does not age a recent check through an intentional ongoing pause", () => {
    const from = +now - 3 * hour;
    const data = history({
      createdAt: new Date(from),
      checks: checksBetween(from, from + hour),
      events: [pause(from + hour + 5 * minute)],
      isPaused: true,
    });
    expect(summarizeMonitor(data, now).availability).toEqual({ percent: null, coverage: 65 / 180 });
  });
});

describe("latency and UTC presentation", () => {
  it("uses continuous p95 and successful measured checks, leaving empty buckets null", () => {
    const end = new Date("2026-11-12T12:22:00.000Z");
    const createdAt = new Date("2026-11-12T11:58:00.000Z");
    const data = history({
      createdAt,
      checks: [
        check(+createdAt, 100),
        check(+createdAt + minute, 200),
        check(+createdAt + 2 * minute, 400, false),
        check(+createdAt + 3 * minute, null),
        check(+end, 300),
        check(+end + 1, 400),
      ],
    });
    const result = buildMonitorInsights(data, "24h", end);
    const boundary = +createdAt + 2 * minute;
    expect(result.latency).toEqual({ averageMs: 200, p95Ms: 290, samples: 3 });
    expect(result.buckets).toEqual([
      { start: +createdAt, end: boundary, averageMs: 150, p95Ms: 195, samples: 2 },
      { start: boundary, end: boundary + 15 * minute, averageMs: null, p95Ms: null, samples: 0 },
      { start: boundary + 15 * minute, end: +end, averageMs: 300, p95Ms: 300, samples: 1 },
    ]);
    expect(result.incidentBands).toEqual([]);
  });

  it.each(["24h", "7d", "30d"] as const)("counts a check exactly at now once in %s", (range) => {
    const result = buildMonitorInsights(history({ checks: [check(+now)] }), range, now);
    expect(result.latency.samples).toBe(1);
    expect(result.buckets.at(-1)?.samples).toBe(1);
    expect(result.buckets.reduce((total, item) => total + item.samples, 0)).toBe(1);
  });

  it("includes today, clips its coverage to now and counts an incident crossing midnight on both days", () => {
    const midnight = Date.parse("2026-11-12T00:00:00.000Z");
    const end = new Date(midnight + 3 * hour);
    const data = history({
      createdAt: new Date(midnight - day - 3 * hour),
      checks: checksBetween(midnight - day - 3 * hour, +end),
      incidents: [incident(midnight - hour, midnight + hour)],
    });
    const { days } = buildMonitorInsights(data, "24h", end);
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({
      start: midnight - 29 * day,
      percent: null,
      coverage: 0,
      incidentCount: 0,
    });
    expect(days.at(-2)).toEqual({
      start: midnight - day,
      percent: 100 * (1 - 1 / 24),
      coverage: 1,
      incidentCount: 1,
    });
    expect(days.at(-1)).toEqual({
      start: midnight,
      percent: 100 * (1 - 1 / 3),
      coverage: 1,
      incidentCount: 1,
    });
  });
});
