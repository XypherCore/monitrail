import { describe, expect, it } from "vitest";
import { advanceCheck, classifyCheck, type MonitorCheckState } from "./check-state.ts";

const initial: MonitorCheckState = {
  status: "pending",
  failures: 0,
  successes: 0,
  streakStartedAt: null,
  streakFirstError: null,
};
const okay = classifyCheck("2xx", { statusCode: 204 });
const timeout = classifyCheck("2xx", { errorType: "timeout" });
const bad = classifyCheck("2xx", { statusCode: 503 });
const times = Array.from({ length: 10 }, (_, index) =>
  new Date(Date.UTC(2026, 10, 8, 0, index)).toISOString()
);
const interval = 600;

describe("server-side success classification", () => {
  it.each([
    [199, false, false],
    [200, true, true],
    [299, true, true],
    [300, false, true],
    [399, false, true],
    [400, false, false],
    [599, false, false],
  ])("classifies status %s against both expected-status policies", (statusCode, strict, relaxed) => {
    expect(classifyCheck("2xx", { statusCode })).toEqual({
      ok: strict,
      errorType: strict ? null : "bad_status",
    });
    expect(classifyCheck("2xx_3xx", { statusCode })).toEqual({
      ok: relaxed,
      errorType: relaxed ? null : "bad_status",
    });
  });

  it("keeps the allowlisted transport cause as a failure", () => {
    expect(classifyCheck("2xx_3xx", { errorType: "timeout" })).toEqual({
      ok: false,
      errorType: "timeout",
    });
  });
});

describe("incident transitions", () => {
  it("returns to the regular interval after an isolated failure", () => {
    const first = advanceCheck(initial, timeout, times[0], interval);
    expect(first).toMatchObject({
      state: { status: "pending", failures: 1, streakStartedAt: times[0] },
      delaySeconds: 60,
      incident: null,
    });
    const next = advanceCheck(first.state, okay, times[1], interval);
    expect(next).toEqual({
      state: {
        ...initial,
        status: "up",
        successes: 1,
      },
      delaySeconds: interval,
      incident: null,
    });
    expect(initial.failures).toBe(0);
  });

  it("opens once on the second failure and remembers the first failure's cause", () => {
    const first = advanceCheck(initial, timeout, times[0], interval);
    const confirmed = advanceCheck(first.state, bad, times[1], interval);
    expect(confirmed).toMatchObject({
      state: { status: "down", failures: 2, successes: 0 },
      delaySeconds: interval,
      incident: { kind: "down", observedAt: times[0], cause: "timeout" },
    });
    expect(advanceCheck(confirmed.state, bad, times[2], interval)).toMatchObject({
      state: { status: "down", failures: 3 },
      delaySeconds: interval,
      incident: null,
    });
  });

  it("requires consecutive successes and closes at the first success of the final streak", () => {
    const first = advanceCheck(initial, timeout, times[0], interval);
    const confirmed = advanceCheck(first.state, bad, times[1], interval);
    const recovering = advanceCheck(confirmed.state, okay, times[2], interval);
    expect(recovering).toMatchObject({
      state: { status: "down", successes: 1, streakStartedAt: times[2] },
      delaySeconds: 60,
      incident: null,
    });
    const flapped = advanceCheck(recovering.state, timeout, times[3], interval);
    expect(flapped).toMatchObject({
      state: { status: "down", failures: 1, successes: 0 },
      delaySeconds: interval,
      incident: null,
    });
    const recoveringAgain = advanceCheck(flapped.state, okay, times[4], interval);
    expect(advanceCheck(recoveringAgain.state, okay, times[5], interval)).toMatchObject({
      state: { status: "up", successes: 2, streakStartedAt: null, streakFirstError: null },
      delaySeconds: interval,
      incident: { kind: "up", observedAt: times[4] },
    });
  });
});
