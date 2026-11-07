import { MonitorAccessError } from "../data/monitor-access.ts";
import { WebGuardError } from "../security/web-ssrf.ts";
import { MonitorInputError, type MonitorField } from "./input.ts";
import { MONITOR_LIMITS } from "./limits.ts";

type MonitorApiError = {
  status: number;
  message: string;
  field?: MonitorField;
  retryAfterSeconds?: number;
};

export function mapMonitorError(error: unknown): MonitorApiError | null {
  if (error instanceof MonitorInputError) {
    return { status: 400, message: error.message, field: error.field };
  }
  if (error instanceof WebGuardError) {
    if (error.code === "blocked") {
      return {
        status: 400,
        field: "url",
        message: "Use an unblocked public HTTP or HTTPS address on port 80, 443, 8080 or 8443. Omit usernames and passwords.",
      };
    }
    if (error.code === "dns") {
      return { status: 400, field: "url", message: "The hostname could not be safely resolved. Check the URL and try again." };
    }
    return { status: 503, field: "url", message: "URL validation is temporarily unavailable. Try again." };
  }
  if (!(error instanceof MonitorAccessError)) return null;
  switch (error.code) {
    case "user_limit":
      return { status: 409, message: `Your account has reached the limit of ${MONITOR_LIMITS.user} monitors.` };
    case "global_limit":
      return { status: 409, message: `The service has reached its limit of ${MONITOR_LIMITS.global} monitors.` };
    case "host_limit":
      return { status: 409, field: "url", message: `This hostname has reached the limit of ${MONITOR_LIMITS.host} monitors.` };
    case "validation_limit": {
      const retryAfterSeconds = error.retryAfterSeconds ?? MONITOR_LIMITS.validationWindowSeconds;
      return {
        status: 429,
        field: "url",
        retryAfterSeconds,
        message: `You can validate up to ${MONITOR_LIMITS.validations} URLs per hour. Try again in ${retryAfterSeconds} seconds.`,
      };
    }
    case "blocked":
      return { status: 400, field: "url", message: "This hostname cannot be monitored." };
    case "blocked_resume":
      return { status: 409, field: "url", message: "Save a URL that passes validation before resuming this monitor." };
    case "unavailable":
      return { status: 503, message: "The monitor could not be saved. Try again." };
  }
}
