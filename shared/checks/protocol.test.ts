import { describe, expect, it } from "vitest";
import {
  MAX_CHECK_BATCH,
  parseClaimRequest,
  parseClaimResponse,
  parseIngestRequest,
  parseIngestResponse,
} from "./protocol.ts";

const attempt_id = "00000000-0000-4000-8000-000000000001";
const monitor_id = "00000000-0000-4000-8000-000000000002";
const instant = "2026-11-08T01:02:03.000Z";
const identity = { attempt_id, monitor_id, config_rev: 1 };
const job = { ...identity, url: "https://example.invalid", expected_status: "2xx", due_at: instant };
const result = { ...identity, started_at: instant, redirect_count: 2, status_code: 304, response_ms: 42 };

describe("internal wire payloads", () => {
  it("accepts the canonical claim, measured and transport-error shapes", () => {
    expect(parseClaimRequest({ max: 15 })).toEqual({ max: 15 });
    const claim = { jobs: [job], blocklist: [{ host: "example.invalid", include_subdomains: true }] };
    expect(parseClaimResponse(claim)).toEqual(claim);
    const error = { ...identity, started_at: instant, redirect_count: 0, error_type: "tls" };
    expect(parseIngestRequest({ results: [result, error] })).toEqual({ results: [result, error] });
    expect(parseIngestResponse({ results: [{ attempt_id, outcome: "accepted" }] }))
      .toEqual({ results: [{ attempt_id, outcome: "accepted" }] });
  });

  it.each([
    { ...result, status_code: 600 },
    { ...result, response_ms: -1 },
    { ...result, response_ms: 1.5 },
    { ...result, redirect_count: 3 },
    { ...result, config_rev: 0 },
    { ...result, config_rev: 2147483648 },
    { ...result, started_at: "2026-02-30T01:02:03.000Z" },
    { ...result, started_at: "2026-11-08T01:02:03+00:00" },
    { ...result, ok: true },
    { ...result, error_type: "timeout" },
    { ...identity, started_at: instant, redirect_count: 0, error_type: "bad_status" },
  ])("rejects ambiguous or out-of-contract result fields", (value) => {
    expect(() => parseIngestRequest({ results: [value] })).toThrow("Invalid internal check payload.");
  });

  it("rejects extra fields, over-limit batches, duplicate jobs and unsafe blocklist shapes", () => {
    expect(() => parseClaimRequest({ max: 15, secret: "fixture" })).toThrow();
    expect(() => parseClaimRequest({ max: 14 })).toThrow();
    expect(() => parseIngestRequest({ results: Array(MAX_CHECK_BATCH + 1).fill(result) })).toThrow();
    expect(() => parseClaimResponse({ jobs: [job, job], blocklist: [] })).toThrow();
    expect(() => parseClaimResponse({ jobs: [], blocklist: [{ host: "EXAMPLE.invalid", include_subdomains: true }] })).toThrow();
    expect(() => parseIngestResponse({ results: [{ attempt_id, outcome: "ok" }] })).toThrow();
  });
});
