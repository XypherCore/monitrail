import type { CheckTransportError } from "../../../shared/checks/protocol.ts";

export const FAILURE_THRESHOLD = 2;
export const RECOVERY_THRESHOLD = 2;
export const CONFIRM_RETRY = 60;

export type CheckError = CheckTransportError | "bad_status";
export type MonitorCheckState = {
  status: "pending" | "up" | "down";
  failures: number;
  successes: number;
  streakStartedAt: string | null;
  streakFirstError: CheckError | null;
};
type CheckOutcome = { ok: true; errorType: null } | { ok: false; errorType: CheckError };
type IncidentTransition =
  | { kind: "down"; observedAt: string; cause: CheckError }
  | { kind: "up"; observedAt: string };

export function classifyCheck(
  expectedStatus: "2xx" | "2xx_3xx",
  result: { statusCode: number } | { errorType: CheckTransportError },
): CheckOutcome {
  if ("errorType" in result) return { ok: false, errorType: result.errorType };
  const upper = expectedStatus === "2xx_3xx" ? 400 : 300;
  return result.statusCode >= 200 && result.statusCode < upper
    ? { ok: true, errorType: null }
    : { ok: false, errorType: "bad_status" };
}

/** Transition one accepted observation without changing the previous snapshot. */
export function advanceCheck(
  current: Readonly<MonitorCheckState>,
  result: CheckOutcome,
  checkedAt: string,
  intervalSeconds: number,
): { state: MonitorCheckState; delaySeconds: number; incident: IncidentTransition | null } {
  const state: MonitorCheckState = {
    status: current.status,
    failures: current.failures,
    successes: current.successes,
    streakStartedAt: current.streakStartedAt,
    streakFirstError: current.streakFirstError,
  };
  let incident: IncidentTransition | null = null;

  if (result.ok) {
    state.failures = 0;
    state.successes += 1;
    if (current.status === "down" && state.successes === 1) {
      state.streakStartedAt = checkedAt;
      state.streakFirstError = null;
    } else if (current.status === "down") {
      if (state.successes >= RECOVERY_THRESHOLD) {
        if (!current.streakStartedAt) throw new Error("Missing recovery onset.");
        incident = { kind: "up", observedAt: current.streakStartedAt };
        state.status = "up";
      }
    } else {
      state.status = "up";
    }
    if (state.status === "up") {
      state.streakStartedAt = null;
      state.streakFirstError = null;
    }
  } else {
    state.successes = 0;
    state.failures += 1;
    if (state.failures === 1) {
      state.streakStartedAt = checkedAt;
      state.streakFirstError = result.errorType;
    }
    if (current.status !== "down" && state.failures >= FAILURE_THRESHOLD) {
      if (!state.streakStartedAt || !state.streakFirstError) throw new Error("Missing failure onset.");
      incident = {
        kind: "down",
        observedAt: state.streakStartedAt,
        cause: state.streakFirstError,
      };
      state.status = "down";
    }
  }

  const unsettled = state.status === "down" ? state.successes > 0 : state.failures > 0;
  return { state, delaySeconds: unsettled ? CONFIRM_RETRY : intervalSeconds, incident };
}
