import { describe, expect, it, vi } from "vitest";
import {
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_CLAIM_PATH,
  INTERNAL_INGEST_PATH,
  INTERNAL_MAINTENANCE_PATH,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  type InternalPath,
  signInternalRequest,
} from "../../../shared/checks/signing.ts";
import type { CheckCapabilities } from "./capabilities.ts";
import { createInternalHandlers } from "./internal-http.ts";

const secret = "fixture-internal-secret-for-unit-tests";
const now = new Date("2026-11-08T02:03:04.000Z");
const nonce = "00000000-0000-4000-8000-000000000001";
const monitorId = "00000000-0000-4000-8000-000000000002";
const claim = '{"max":15}';
const result = {
  attempt_id: nonce,
  monitor_id: monitorId,
  config_rev: 1,
  started_at: now.toISOString(),
  redirect_count: 2,
  status_code: 304,
  response_ms: 10,
};
const ingest = JSON.stringify({ results: [result] });

async function signed(path: InternalPath, body: string, instant = now) {
  return signInternalRequest(secret, path, body, { now: instant, nonce });
}

function request(path: string, headers: Headers, body = claim, method = "POST") {
  return new Request(`https://app.example.invalid${path}`, {
    method,
    headers,
    body: method === "POST" ? body : undefined,
  });
}

function setup() {
  const checks = {
    claimChecks: vi.fn<CheckCapabilities["claimChecks"]>().mockResolvedValue({
      jobs: [{
        attemptId: nonce,
        monitorId,
        configRev: 1,
        url: "https://example.invalid",
        expectedStatus: "2xx",
        dueAt: now,
      }],
      blocklist: [{ host: "deny.example.invalid", includeSubdomains: true }],
    }),
    ingestResults: vi.fn<CheckCapabilities["ingestResults"]>().mockResolvedValue([
      { attemptId: nonce, outcome: "accepted" },
    ]),
  };
  const consumeNonce = vi.fn<(value: string) => Promise<boolean>>().mockResolvedValue(true);
  const tasks: Array<() => Promise<void>> = [];
  const deliverOutbox = vi.fn<() => Promise<{ sent: number; retrying: number; failed: number }>>()
    .mockResolvedValue({ sent: 0, retrying: 0, failed: 0 });
  const maintenance = vi.fn().mockResolvedValue({ removed: 3, dnsRevalidated: 2, blocked: 1 });
  const handlers = createInternalHandlers({
    secret: () => secret,
    checks: () => checks,
    consumeNonce,
    now: () => now,
    maintenance: () => ({ runMaintenance: maintenance }),
    delivery: { afterResponse: (task) => { tasks.push(task); }, run: deliverOutbox },
  });
  return { handlers, consumeNonce, checks, tasks, deliverOutbox, maintenance };
}

describe("signed check endpoints", () => {
  it("runs maintenance through the signed capability without scheduling check delivery", async () => {
    const { handlers, maintenance, tasks } = setup();
    const body = "{}";
    const response = await handlers.maintenance(request(INTERNAL_MAINTENANCE_PATH, await signed(INTERNAL_MAINTENANCE_PATH, body), body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ removed: 3, dnsRevalidated: 2, blocked: 1 });
    expect(maintenance).toHaveBeenCalledOnce();
    expect(tasks).toHaveLength(0);
  });

  it.each(["", "null", "[]", '{"max":15}'])("refuses a maintenance body %j without calling the capability", async (body) => {
    const { handlers, maintenance } = setup();
    const response = await handlers.maintenance(request(INTERNAL_MAINTENANCE_PATH, await signed(INTERNAL_MAINTENANCE_PATH, body), body));
    expect(response.status).toBe(400);
    expect(maintenance).not.toHaveBeenCalled();
  });

  it("refuses a claim signature at maintenance and rejects replayed maintenance", async () => {
    const { handlers, consumeNonce, maintenance } = setup();
    const body = "{}";
    const mismatched = await handlers.maintenance(request(INTERNAL_MAINTENANCE_PATH, await signed(INTERNAL_CLAIM_PATH, body), body));
    expect(mismatched.status).toBe(401);
    expect(maintenance).not.toHaveBeenCalled();
    consumeNonce.mockResolvedValue(false);
    const replayed = await handlers.maintenance(request(INTERNAL_MAINTENANCE_PATH, await signed(INTERNAL_MAINTENANCE_PATH, body), body));
    expect(replayed.status).toBe(401);
    expect(maintenance).not.toHaveBeenCalled();
  });
  it("claims through a narrow capability and emits only the wire job and blocklist fields", async () => {
    const { handlers, consumeNonce, checks } = setup();
    const response = await handlers.claim(request(INTERNAL_CLAIM_PATH, await signed(INTERNAL_CLAIM_PATH, claim)));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      jobs: [{
        attempt_id: nonce,
        monitor_id: monitorId,
        config_rev: 1,
        url: "https://example.invalid",
        expected_status: "2xx",
        due_at: now.toISOString(),
      }],
      blocklist: [{ host: "deny.example.invalid", include_subdomains: true }],
    });
    expect(consumeNonce).toHaveBeenCalledWith(nonce);
    expect(checks.claimChecks).toHaveBeenCalledWith({ max: 15 });
  });

  it("translates ingest and leaves status interpretation to the server capability", async () => {
    const { handlers, checks } = setup();
    const response = await handlers.ingest(request(INTERNAL_INGEST_PATH, await signed(INTERNAL_INGEST_PATH, ingest), ingest));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [{ attempt_id: nonce, outcome: "accepted" }] });
    expect(checks.ingestResults).toHaveBeenCalledWith({ results: [{
      attemptId: nonce, monitorId, configRev: 1, startedAt: now, redirectCount: 2, statusCode: 304, responseMs: 10,
    }] });
  });

  it("schedules delivery after empty claim and ingest responses without waiting for a slow recipient", async () => {
    const { handlers, checks, tasks, deliverOutbox } = setup();
    const slow = Promise.withResolvers<{ sent: number; retrying: number; failed: number }>();
    deliverOutbox.mockReturnValueOnce(slow.promise);
    checks.claimChecks.mockResolvedValueOnce({ jobs: [], blocklist: [] });
    const empty = await handlers.claim(request(INTERNAL_CLAIM_PATH, await signed(INTERNAL_CLAIM_PATH, claim)));
    expect(await empty.json()).toEqual({ jobs: [], blocklist: [] });
    expect(tasks).toHaveLength(1);
    expect(deliverOutbox).not.toHaveBeenCalled();
    const running = tasks[0]();
    try {
      const ingested = await handlers.ingest(request(INTERNAL_INGEST_PATH, await signed(INTERNAL_INGEST_PATH, ingest), ingest));
      expect(ingested.status).toBe(200);
      expect(tasks).toHaveLength(2);
      expect(deliverOutbox).toHaveBeenCalledTimes(1);
    } finally {
      slow.resolve({ sent: 1, retrying: 0, failed: 0 });
      await running;
    }
    await tasks[1]();
    expect(deliverOutbox).toHaveBeenCalledTimes(2);
  });

  it.each([
    [INTERNAL_SIGNATURE_HEADER, "f".repeat(64)],
    [INTERNAL_SIGNATURE_HEADER, "A".repeat(64)],
    [INTERNAL_TIMESTAMP_HEADER, "0001234"],
    [INTERNAL_NONCE_HEADER, `${nonce}, ${nonce}`],
  ])("rejects a bad or noncanonical %s before durable nonce use", async (header, value) => {
    const { handlers, consumeNonce, checks, tasks } = setup();
    const headers = await signed(INTERNAL_CLAIM_PATH, claim);
    headers.set(header, value);
    const response = await handlers.claim(request(INTERNAL_CLAIM_PATH, headers));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(consumeNonce).not.toHaveBeenCalled();
    expect(checks.claimChecks).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it.each([-61, 61])("rejects timestamp skew of %s seconds", async (seconds) => {
    const { handlers, consumeNonce } = setup();
    const signedAt = new Date(now.getTime() + seconds * 1000);
    const response = await handlers.claim(request(INTERNAL_CLAIM_PATH, await signed(INTERNAL_CLAIM_PATH, claim, signedAt)));
    expect(response.status).toBe(401);
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it.each([-60, 60])("accepts the inclusive skew boundary at %s seconds", async (seconds) => {
    const { handlers } = setup();
    const signedAt = new Date(now.getTime() + seconds * 1000);
    const response = await handlers.claim(request(INTERNAL_CLAIM_PATH, await signed(INTERNAL_CLAIM_PATH, claim, signedAt)));
    expect(response.status).toBe(200);
  });

  it("rejects method, endpoint, query-string and exact-byte substitutions", async () => {
    const { handlers, consumeNonce } = setup();
    const headers = await signed(INTERNAL_CLAIM_PATH, claim);
    const responses = [
      await handlers.claim(request(INTERNAL_CLAIM_PATH, headers, claim, "GET")),
      await handlers.ingest(request(INTERNAL_INGEST_PATH, headers)),
      await handlers.claim(request(`${INTERNAL_CLAIM_PATH}?other=1`, headers)),
      await handlers.claim(request(INTERNAL_CLAIM_PATH, headers, '{"max": 15}')),
    ];
    expect(responses.map((response) => response.status)).toEqual([405, 401, 401, 401]);
    expect(responses.every((response) => response.headers.get("cache-control") === "no-store")).toBe(true);
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it("rejects nonce reuse and fails closed when nonce storage is unavailable", async () => {
    const { handlers, consumeNonce, checks, tasks } = setup();
    consumeNonce.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("sensitive storage diagnostic"));
    const headers = await signed(INTERNAL_CLAIM_PATH, claim);
    const replay = await handlers.claim(request(INTERNAL_CLAIM_PATH, headers));
    const unavailable = await handlers.claim(request(INTERNAL_CLAIM_PATH, headers));
    expect(replay.status).toBe(401);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("sensitive");
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(checks.claimChecks).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });

  it("bounds body bytes before nonce use with or without a declared length", async () => {
    const { handlers, consumeNonce } = setup();
    const headers = await signed(INTERNAL_CLAIM_PATH, claim);
    const oversized = "é".repeat(INTERNAL_BODY_LIMIT_BYTES);
    const implicit = await handlers.claim(request(INTERNAL_CLAIM_PATH, headers, oversized));
    headers.set("content-length", String(INTERNAL_BODY_LIMIT_BYTES + 1));
    const declared = await handlers.claim(request(INTERNAL_CLAIM_PATH, headers));
    expect([implicit.status, declared.status]).toEqual([413, 413]);
    expect(consumeNonce).not.toHaveBeenCalled();
  });

  it("bounds stalled uploads without waiting for stream cancellation", async () => {
    const { handlers, consumeNonce } = setup();
    const headers = await signed(INTERNAL_CLAIM_PATH, claim);
    vi.useFakeTimers();
    try {
      const upload = new ReadableStream<Uint8Array>({
        cancel() { return new Promise<void>(() => {}); },
      });
      const streaming = new Request(`https://app.example.invalid${INTERNAL_CLAIM_PATH}`, {
        method: "POST", headers, body: upload, duplex: "half",
      } as RequestInit & { duplex: "half" });
      const response = handlers.claim(streaming);
      await vi.advanceTimersByTimeAsync(10000);
      expect((await response).status).toBe(408);
      expect(consumeNonce).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid JSON and client-supplied success even if correctly signed", async () => {
    const { handlers, checks, tasks } = setup();
    const bad = JSON.stringify({ results: [{ ...result, ok: true }] });
    const malformed = await handlers.claim(request(INTERNAL_CLAIM_PATH, await signed(INTERNAL_CLAIM_PATH, "["), "["));
    const unexpected = await handlers.ingest(request(INTERNAL_INGEST_PATH, await signed(INTERNAL_INGEST_PATH, bad), bad));
    expect([malformed.status, unexpected.status]).toEqual([400, 400]);
    expect(checks.claimChecks).not.toHaveBeenCalled();
    expect(checks.ingestResults).not.toHaveBeenCalled();
    expect(tasks).toHaveLength(0);
  });
});
