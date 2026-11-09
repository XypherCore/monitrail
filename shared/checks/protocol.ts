import { canonicalPolicyHost } from "../ssrf/address.ts";
import { isInternalUuid } from "./signing.ts";

export const MAX_CHECK_BATCH = 15;

export type CheckTransportError = "dns" | "timeout" | "tls" | "connect" | "blocked" | "other";
export type CheckOutcome = "accepted" | "dropped" | "error";

export type ClaimResponse = {
  jobs: {
    attempt_id: string;
    monitor_id: string;
    config_rev: number;
    url: string;
    expected_status: "2xx" | "2xx_3xx";
    due_at: string;
  }[];
  blocklist: { host: string; include_subdomains: boolean }[];
};

type IngestEntry = {
  attempt_id: string;
  monitor_id: string;
  config_rev: number;
  started_at: string;
  redirect_count: number;
} & ({ status_code: number; response_ms: number } | { error_type: CheckTransportError });

export type IngestRequest = { results: IngestEntry[] };
export type IngestResponse = { results: { attempt_id: string; outcome: CheckOutcome }[] };

const commonFields = ["attempt_id", "monitor_id", "config_rev"];
const ingestFields = [...commonFields, "started_at", "redirect_count"];
const transportErrors = new Set<unknown>(["dns", "timeout", "tls", "connect", "blocked", "other"]);

function invalid(): never {
  throw new Error("Invalid internal check payload.");
}

function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function boundedInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function checkIdentity(row: Record<string, unknown>): boolean {
  return isInternalUuid(row.attempt_id) && isInternalUuid(row.monitor_id) &&
    boundedInteger(row.config_rev, 1, 2147483647);
}

function utcTimestamp(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    value.startsWith("0000")
  ) return false;
  const time = new Date(value);
  return Number.isFinite(time.getTime()) && time.toISOString() === value;
}

export function parseClaimRequest(value: unknown): { max: typeof MAX_CHECK_BATCH } {
  if (!exactFields(value, ["max"]) || value.max !== MAX_CHECK_BATCH) invalid();
  return { max: MAX_CHECK_BATCH };
}

export function parseClaimResponse(value: unknown): ClaimResponse {
  if (
    !exactFields(value, ["jobs", "blocklist"]) ||
    !Array.isArray(value.jobs) || value.jobs.length > MAX_CHECK_BATCH ||
    !Array.isArray(value.blocklist)
  ) invalid();
  const attempts = new Set<unknown>();
  const monitors = new Set<unknown>();
  for (const job of value.jobs) {
    if (
      !exactFields(job, [...commonFields, "url", "expected_status", "due_at"]) ||
      !checkIdentity(job) ||
      typeof job.url !== "string" || job.url.length === 0 ||
      (job.expected_status !== "2xx" && job.expected_status !== "2xx_3xx") ||
      !utcTimestamp(job.due_at) ||
      attempts.has(job.attempt_id) || monitors.has(job.monitor_id)
    ) invalid();
    attempts.add(job.attempt_id);
    monitors.add(job.monitor_id);
  }
  for (const entry of value.blocklist) {
    if (
      !exactFields(entry, ["host", "include_subdomains"]) ||
      typeof entry.host !== "string" || canonicalPolicyHost(entry.host) !== entry.host ||
      typeof entry.include_subdomains !== "boolean"
    ) invalid();
  }
  return value as ClaimResponse;
}

export function parseIngestRequest(value: unknown): IngestRequest {
  if (
    !exactFields(value, ["results"]) ||
    !Array.isArray(value.results) || value.results.length > MAX_CHECK_BATCH
  ) invalid();
  for (const result of value.results) {
    const measured = exactFields(result, [...ingestFields, "status_code", "response_ms"]) &&
      boundedInteger(result.status_code, 100, 599) &&
      boundedInteger(result.response_ms, 0, 10000);
    const failed = exactFields(result, [...ingestFields, "error_type"]) &&
      transportErrors.has(result.error_type);
    if (
      (!measured && !failed) ||
      !checkIdentity(result) ||
      !utcTimestamp(result.started_at) ||
      !boundedInteger(result.redirect_count, 0, 2)
    ) invalid();
  }
  return value as IngestRequest;
}

export function parseIngestResponse(value: unknown): IngestResponse {
  if (
    !exactFields(value, ["results"]) ||
    !Array.isArray(value.results) || value.results.length > MAX_CHECK_BATCH
  ) invalid();
  for (const entry of value.results) {
    if (
      !exactFields(entry, ["attempt_id", "outcome"]) ||
      !isInternalUuid(entry.attempt_id) ||
      (entry.outcome !== "accepted" && entry.outcome !== "dropped" && entry.outcome !== "error")
    ) invalid();
  }
  return value as IngestResponse;
}
