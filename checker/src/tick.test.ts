import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "../../shared/ssrf/io.ts";
import worker from "./index.ts";
import { CHECK_CRON, runCheckTick } from "./tick.ts";

const env = {
  APP_URL: "https://app.example",
  INTERNAL_HMAC_SECRET: "synthetic-test-only-secret-for-checker-requests",
};
const tickTime = Date.parse("2026-11-08T00:00:00.000Z");
const due = new Date(tickTime - 12_000).toISOString();
const claimUrl = `${env.APP_URL}/api/internal/claim`;
const ingestUrl = `${env.APP_URL}/api/internal/ingest`;
const attemptId = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const monitorId = (number: number) =>
  `10000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const job = (number: number, url = `https://target.example/${number}?token=synthetic-private`) => ({
  attempt_id: attemptId(number),
  monitor_id: monitorId(number),
  config_rev: 3,
  url,
  expected_status: "2xx_3xx",
  due_at: due,
});
const claim = (jobs: ReturnType<typeof job>[] = [], blocklist: unknown[] = []) =>
  Response.json({ jobs, blocklist });
const ack = (number: number, outcome = "accepted") => ({
  attempt_id: attemptId(number),
  outcome,
});
const hex = (data: ArrayBuffer) =>
  Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");

async function expectSigned([url, init]: Parameters<Transport>) {
  expect(init).toMatchObject({
    method: "POST",
    redirect: "manual",
    cache: "no-store",
    credentials: "omit",
  });
  const headers = new Headers(init.headers);
  expect(headers.get("content-type")).toBe("application/json");
  const nonce = headers.get("x-monitrail-nonce");
  const timestamp = headers.get("x-monitrail-ts");
  expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
  expect(timestamp).toMatch(/^\d+$/);

  const encoder = new TextEncoder();
  const bodyHash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(String(init.body))));
  const expected = `v1\nPOST\n${new URL(url).pathname}\n${timestamp}\n${nonce}\n${bodyHash}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.INTERNAL_HMAC_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  expect(headers.get("x-monitrail-sig")).toBe(
    hex(await crypto.subtle.sign("HMAC", key, encoder.encode(expected))),
  );
  return nonce;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("checker tick", () => {
  it("sends one signed claim and skips ingest when no monitors are due", async () => {
    const transport = vi.fn<Transport>(async () => claim());
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "idle",
      jobs: 0,
      subrequests: 1,
      maxSlotLatenessMs: 0,
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      claimUrl,
      expect.objectContaining({ body: '{"max":15}' }),
    );
    await expectSigned(transport.mock.calls[0]);
  });

  it("runs six guarded checks at a time and stays within 48 subrequests with a retry", async () => {
    const jobs = Array.from({ length: 15 }, (_, number) => job(number + 1));
    let active = 0;
    let peak = 0;
    let ingestAttempts = 0;
    const transport = vi.fn<Transport>(async (input) => {
      if (input === claimUrl) return claim(jobs);
      if (input === ingestUrl) {
        const first = ingestAttempts++ === 0;
        const firstJobOutcome = first ? "error" : "accepted";
        const otherJobOutcome = first ? "accepted" : "dropped";
        return Response.json({
          results: jobs.map((_, index) =>
            ack(index + 1, index === 0 ? firstJobOutcome : otherJobOutcome),
          ),
        });
      }
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
      active--;
      const target = new URL(input);
      const level = Number(target.searchParams.get("hop"));
      if (level === 2) return new Response(null, { status: 302 });
      return new Response(null, {
        status: 302,
        headers: { location: `${target.pathname}?hop=${level + 1}` },
      });
    });
    await expect(runCheckTick(env, { fetch: transport, now: () => tickTime })).resolves.toEqual({
      outcome: "completed",
      jobs: 15,
      subrequests: 48,
      maxSlotLatenessMs: 12_000,
      accepted: 15,
      dropped: 0,
      errors: 0,
    });
    expect(peak).toBe(6);
    expect(ingestAttempts).toBe(2);
    const sent = transport.mock.calls.at(-1);
    expect(sent?.[0]).toBe(ingestUrl);
    expect(String(sent?.[1].body)).not.toMatch(/synthetic-private|target\.example|expected_status|\bok\b/);
    expect(JSON.parse(String(sent?.[1].body))).toEqual({
      results: jobs.map((item) => ({
        attempt_id: item.attempt_id,
        monitor_id: item.monitor_id,
        config_rev: 3,
        started_at: new Date(tickTime).toISOString(),
        status_code: 302,
        response_ms: expect.any(Number),
        redirect_count: 2,
      })),
    });
    const targetCalls = transport.mock.calls.slice(1, -2);
    expect(targetCalls).toHaveLength(45);
    for (const [input, init] of targetCalls) {
      expect(new URL(input).hostname).toBe("target.example");
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
      expect(new Headers(init.headers).has("x-monitrail-sig")).toBe(false);
    }
    if (sent) await expectSigned(sent);
  });

  it("replays a failed whole ingest batch once with the same body and a fresh signature", async () => {
    const transport = vi.fn<Transport>()
      .mockResolvedValueOnce(claim([job(1)]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockRejectedValueOnce(new Error("synthetic private diagnostic"))
      .mockResolvedValueOnce(Response.json({ results: [ack(1, "dropped")] }));

    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "completed",
      subrequests: 4,
      dropped: 1,
      accepted: 0,
    });
    const [first, second] = transport.mock.calls.slice(2);
    expect(first[0]).toBe(ingestUrl);
    expect(second[0]).toBe(ingestUrl);
    expect(first[1].body).toBe(second[1].body);
    expect(await expectSigned(first)).not.toBe(await expectSigned(second));
  });

  it("rejects acknowledgements for unrelated attempts and reports failure after one retry", async () => {
    const transport = vi.fn<Transport>()
      .mockResolvedValueOnce(claim([job(1)]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ results: [ack(2)] }))
      .mockResolvedValueOnce(Response.json({ results: [ack(2)] }));
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "ingest_error",
      accepted: 0,
      subrequests: 4,
      errors: 1,
    });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("preserves definitive outcomes when the second response reports a secondary error", async () => {
    let ingestAttempts = 0;
    const transport = vi.fn<Transport>(async (input) => {
      if (input === claimUrl) return claim([job(1), job(2), job(3)]);
      if (input === ingestUrl) {
        return Response.json({
          results: ingestAttempts++ === 0
            ? [ack(1), ack(2, "dropped"), ack(3, "error")]
            : [ack(1, "dropped"), ack(2, "error"), ack(3)],
        });
      }
      return new Response(null, { status: 204 });
    });
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "completed",
      accepted: 2,
      dropped: 1,
      errors: 0,
    });
    const [first, second] = transport.mock.calls.filter(([url]) => url === ingestUrl);
    expect(first[1].body).toBe(second[1].body);
    expect(await expectSigned(first)).not.toBe(await expectSigned(second));
  });

  it("retains the first outcomes if the second ingest request fails", async () => {
    const transport = vi.fn<Transport>()
      .mockResolvedValueOnce(claim([job(1), job(2), job(3)]))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ results: [ack(1), ack(2, "dropped"), ack(3, "error")] }))
      .mockRejectedValueOnce(new Error("synthetic private diagnostic"));
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "ingest_error",
      accepted: 1,
      dropped: 1,
      errors: 1,
      subrequests: 6,
    });
  });

  it("retries a fully errored response once and counts only unresolved attempts", async () => {
    const transport = vi.fn<Transport>()
      .mockResolvedValueOnce(claim([job(1)]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ results: [ack(1, "error")] }))
      .mockResolvedValueOnce(Response.json({ results: [ack(1, "error")] }));
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "ingest_error",
      errors: 1,
      subrequests: 4,
    });
  });

  it("keeps blocklist exclusions away from target transport", async () => {
    const transport = vi.fn<Transport>()
      .mockResolvedValueOnce(claim([job(1)], [{ host: "target.example", include_subdomains: false }]))
      .mockResolvedValueOnce(Response.json({ results: [ack(1)] }));
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "completed",
      subrequests: 2,
      accepted: 1,
    });
    expect(transport.mock.calls[1][0]).toBe(ingestUrl);
    expect(JSON.parse(String(transport.mock.calls[1][1].body))).toEqual({
      results: [expect.objectContaining({ error_type: "blocked", redirect_count: 0 })],
    });
  });

  it.each([
    () => claim(Array.from({ length: 16 }, (_, index) => job(index + 1))),
    () => claim([job(1), job(1)]),
    () => new Response(null, { status: 307, headers: { location: "https://wrong.example" } }),
    () => new Response('{"jobs":[],"blocklist":[]}', { headers: { "content-type": "application/jsonp" } }),
  ])("fails closed on an invalid claim response", async (response) => {
    const transport = vi.fn<Transport>(async () => response());
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "claim_error",
      subrequests: 1,
      jobs: 0,
    });
    expect(transport.mock.calls[0][0]).toBe(claimUrl);
  });

  it("cancels an oversized response without buffering the rest", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { "content-type": "application/json" } },
    );
    const transport = vi.fn<Transport>().mockResolvedValueOnce(response);
    await expect(runCheckTick(env, { fetch: transport })).resolves.toMatchObject({
      outcome: "claim_error",
      subrequests: 1,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a stalled claim even when the control transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const started = Promise.withResolvers<AbortSignal | null | undefined>();
    const transport = vi.fn<Transport>((_input, init) => {
      started.resolve(init.signal);
      return new Promise<Response>(() => {});
    });
    const tick = runCheckTick(env, { fetch: transport });
    const signal = await started.promise;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(tick).resolves.toMatchObject({ outcome: "claim_error", subrequests: 1 });
    expect(signal?.aborted).toBe(true);
  });

  it.each([
    { ...env, APP_URL: "http://app.example" },
    { ...env, APP_URL: "https://u:secret@app.example" },
    { ...env, APP_URL: "https://app.example/?secret=value" },
    { ...env, INTERNAL_HMAC_SECRET: "" },
  ])("rejects unsafe app configuration before sending a request", async (config) => {
    const transport = vi.fn<Transport>();
    await expect(runCheckTick(config, { fetch: transport })).resolves.toMatchObject({
      outcome: "configuration_error",
      subrequests: 0,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("keeps the fetch endpoint closed and uses only the configured cron", async () => {
    const transport = vi.fn<Transport>(async () => claim());
    vi.stubGlobal("fetch", transport);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(worker.fetch().status).toBe(404);
    await worker.scheduled({ cron: "0 0 * * *" } as ScheduledController, env);
    expect(transport).not.toHaveBeenCalled();
    await worker.scheduled({ cron: CHECK_CRON } as ScheduledController, env);
    expect(transport).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "checker_tick",
      expect.objectContaining({ outcome: "idle", subrequests: 1 }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.INTERNAL_HMAC_SECRET);
  });
});
