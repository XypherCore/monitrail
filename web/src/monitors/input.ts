export const MONITOR_INTERVAL_SECONDS = [300, 600, 900, 1800, 3600] as const;
export const MONITOR_EXPECTED_STATUSES = ["2xx", "2xx_3xx"] as const;
export const MONITOR_DEFAULT_INTERVAL_SECONDS = MONITOR_INTERVAL_SECONDS[0];
export const MONITOR_DEFAULT_EXPECTED_STATUS = MONITOR_EXPECTED_STATUSES[0];

export type MonitorFields = {
  name: string;
  url: string;
  intervalSeconds: (typeof MONITOR_INTERVAL_SECONDS)[number];
  expectedStatus: (typeof MONITOR_EXPECTED_STATUSES)[number];
};
export type MonitorEditFields = Omit<MonitorFields, "url"> & { url?: string };
export type MonitorField = keyof MonitorFields;

export class MonitorInputError extends Error {
  readonly field?: MonitorField;

  constructor(message: string, field?: MonitorField) {
    super(message);
    this.name = "MonitorInputError";
    this.field = field;
  }
}

const settings = new Set(["name", "url", "intervalSeconds", "expectedStatus"]);

export function isMonitorId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function fieldsObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MonitorInputError("Send the monitor settings as an object.");
  }
  return value as Record<string, unknown>;
}

export function parseMonitorFields(value: unknown, action: "create"): MonitorFields;
export function parseMonitorFields(value: unknown, action: "edit"): MonitorEditFields;
export function parseMonitorFields(value: unknown, action: "create" | "edit"): MonitorEditFields {
  const input = fieldsObject(value);
  if (Object.keys(input).some((key) => !settings.has(key))) {
    throw new MonitorInputError("Send only the monitor name, URL, interval and expected status.");
  }
  const { name, url } = input;
  if (typeof name !== "string" || !name.trim() || name.includes("\0")) {
    throw new MonitorInputError("Enter a monitor name.", "name");
  }
  if (action === "create" || url !== undefined) {
    if (typeof url !== "string" || !url.trim()) {
      throw new MonitorInputError("Enter a website URL beginning with http:// or https://.", "url");
    }
  }

  const interval = action === "create" && input.intervalSeconds === undefined
    ? MONITOR_DEFAULT_INTERVAL_SECONDS
    : input.intervalSeconds;
  const intervalSeconds = MONITOR_INTERVAL_SECONDS.find((option) => option === interval);
  if (intervalSeconds === undefined) {
    throw new MonitorInputError("Choose an interval of 5, 10, 15, 30 or 60 minutes.", "intervalSeconds");
  }
  const status = action === "create" && input.expectedStatus === undefined
    ? MONITOR_DEFAULT_EXPECTED_STATUS
    : input.expectedStatus;
  const expectedStatus = MONITOR_EXPECTED_STATUSES.find((option) => option === status);
  if (expectedStatus === undefined) {
    throw new MonitorInputError("Choose 2xx or 2xx and 3xx.", "expectedStatus");
  }
  return {
    name: name.trim(),
    intervalSeconds,
    expectedStatus,
    ...(typeof url === "string" ? { url } : {}),
  };
}

export function parseMonitorUpdate(value: unknown):
  { kind: "edit"; fields: MonitorEditFields } | { kind: "pause"; isPaused: boolean } {
  const input = fieldsObject(value);
  if (!Object.hasOwn(input, "isPaused")) return { kind: "edit", fields: parseMonitorFields(input, "edit") };
  if (Object.keys(input).length !== 1 || typeof input.isPaused !== "boolean") {
    throw new MonitorInputError("Send only a true or false pause setting.");
  }
  return { kind: "pause", isPaused: input.isPaused };
}
