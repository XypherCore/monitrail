import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "../../shared/ssrf/io.ts";
import worker, { MAINTENANCE_CRON } from "./index.ts";
import { CHECK_CRON } from "./tick.ts";

const now = Date.parse("2026-11-10T00:00:00.000Z");

function fixture() {
  const send = vi.fn<Queue<"check">["send"]>();
  const transport = vi.fn<Transport>(async () => Response.json({ jobs: [], blocklist: [] }));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubGlobal("fetch", transport);
  return {
    send,
    transport,
    log,
    env: {
      APP_URL: "https://app.example",
      INTERNAL_HMAC_SECRET: "synthetic-test-only-secret-for-queue-tests",
      CHECK_TICKS: {
        send,
        sendBatch: vi.fn<Queue<"check">["sendBatch"]>(),
        metrics: vi.fn<Queue<"check">["metrics"]>(),
      },
    },
  };
}

const controller = (cron: string): ScheduledController => ({
  cron,
  scheduledTime: now,
  noRetry: vi.fn(),
});

const marker = (body: unknown = "check", timestamp = now): Message => ({
  id: "test-marker",
  body,
  timestamp: new Date(timestamp),
  attempts: 1,
  ack: vi.fn(),
  retry: vi.fn(),
});

const batch = (...messages: Message[]): MessageBatch => ({
  queue: "monitrail-check-ticks",
  messages,
  metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
  ackAll: vi.fn(),
  retryAll: vi.fn(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("checker worker", () => {
  it("keeps its public fetch endpoint closed", () => {
    const response = worker.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("enqueues one fixed marker on the configured cron without claiming jobs", async () => {
    const { env, send, transport } = fixture();
    await worker.scheduled(controller("0 0 * * *"), env);
    expect(send).not.toHaveBeenCalled();
    await worker.scheduled(controller(CHECK_CRON), env);
    expect(send).toHaveBeenCalledExactlyOnceWith("check");
    expect(transport).not.toHaveBeenCalled();
  });

  it("surfaces a sanitized enqueue failure", async () => {
    const { env, send, transport } = fixture();
    send.mockRejectedValueOnce(new Error("provider error details"));
    await expect(worker.scheduled(controller(CHECK_CRON), env)).rejects.toThrow(
      "Checker tick enqueue failed.",
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("runs only the daily maintenance request with its own signed path", async () => {
    const { env, send, transport, log } = fixture();
    transport.mockResolvedValueOnce(Response.json({ removed: 3, dnsRevalidated: 2, blocked: 1 }));
    await worker.scheduled(controller(MAINTENANCE_CRON), env);
    expect(send).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      `${env.APP_URL}/api/internal/maintenance`,
      expect.objectContaining({
        method: "POST", body: "{}", redirect: "manual", cache: "no-store", credentials: "omit",
      }),
    );
    const headers = new Headers(transport.mock.calls[0][1].headers);
    const timestamp = headers.get("x-monitrail-ts");
    const nonce = headers.get("x-monitrail-nonce");
    const encoder = new TextEncoder();
    const hex = (data: ArrayBuffer) =>
      Array.from(new Uint8Array(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode("{}")));
    const canonical = `v1\nPOST\n/api/internal/maintenance\n${timestamp}\n${nonce}\n${digest}`;
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(env.INTERNAL_HMAC_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    expect(timestamp).toMatch(/^\d+$/);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("x-monitrail-sig")).toBe(
      hex(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["server failure", () => new Response("private upstream diagnostic", { status: 503 })],
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://other.example" } })],
    ["invalid JSON", () => new Response("private diagnostic", { headers: { "content-type": "application/json" } })],
    ["HTML", () => new Response("<html>private diagnostic</html>", { headers: { "content-type": "text/html" } })],
    ["unrecognized fields", () => Response.json({ removed: 0, dnsRevalidated: 0, blocked: 0, private: true })],
    ["negative counter", () => Response.json({ removed: -1, dnsRevalidated: 0, blocked: 0 })],
    ["oversized counter", () => Response.json({ removed: Number.MAX_SAFE_INTEGER + 1, dnsRevalidated: 0, blocked: 0 })],
    ["missing counter", () => Response.json({ removed: 0, blocked: 0 })],
    ["oversized body", () => new Response(" ".repeat(256 * 1024 + 1), { headers: { "content-type": "application/json" } })],
    ["false length", () => new Response("{}", { headers: { "content-type": "application/json", "content-length": "262145" } })],
  ])("fails maintenance with a sanitized error (%s)", async (_name, response) => {
    const { env, send, transport, log } = fixture();
    transport.mockResolvedValueOnce(response());
    await expect(worker.scheduled(controller(MAINTENANCE_CRON), env)).rejects.toThrow(
      "Maintenance request failed.",
    );
    expect(send).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["bad secret", { INTERNAL_HMAC_SECRET: "invalid" }],
    ["remote HTTP origin", { APP_URL: "http://app.example" }],
    ["credentialed origin", { APP_URL: "https://user:password@app.example" }],
    ["origin with path", { APP_URL: "https://app.example/other" }],
  ])("fails closed before a maintenance request with %s", async (_name, changed) => {
    const { env, send, transport } = fixture();
    await expect(worker.scheduled(controller(MAINTENANCE_CRON), { ...env, ...changed })).rejects.toThrow(
      "Maintenance request failed.",
    );
    expect(send).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it("bounds a stalled maintenance response by the existing control deadline", async () => {
    const { env, transport } = fixture();
    vi.useFakeTimers();
    transport.mockResolvedValueOnce(new Response(new ReadableStream(), {
      headers: { "content-type": "application/json" },
    }));
    const request = expect(worker.scheduled(controller(MAINTENANCE_CRON), env)).rejects.toThrow(
      "Maintenance request failed.",
    );
    await vi.advanceTimersByTimeAsync(120_000);
    await request;
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty batch", () => batch()],
    ["oversized batch", () => batch(marker(), marker())],
    ["unexpected marker", () => batch(marker({ check: true }))],
    ["invalid timestamp", () => batch(marker("check", Number.NaN))],
    ["marker at the age limit", () => batch(marker("check", now - 60_000))],
    ["older marker", () => batch(marker("check", now - 120_000))],
  ])("discards an invalid tick without claiming jobs (%s)", async (_name, makeBatch) => {
    const { env, transport, log } = fixture();
    await expect(worker.queue(makeBatch(), env)).resolves.toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [now - 59_999, 59_999],
    [now + 1, 0],
  ])("runs one fresh marker and logs bounded delay without secrets", async (timestamp, delay) => {
    const { env, send, transport, log } = fixture();
    await worker.queue(batch(marker("check", timestamp)), env);
    expect(send).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      `${env.APP_URL}/api/internal/claim`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "checker_tick",
      expect.objectContaining({ outcome: "idle", subrequests: 1, queueDelayMs: delay }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.INTERNAL_HMAC_SECRET);
  });

  it("reports a sanitized check failure to the queue runtime", async () => {
    const { env, transport, log } = fixture();
    transport.mockResolvedValueOnce(new Response("private upstream details", { status: 503 }));
    await expect(worker.queue(batch(marker()), env)).rejects.toThrow("Checker tick failed.");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "checker_tick",
      expect.objectContaining({ outcome: "claim_error", subrequests: 1, queueDelayMs: 0 }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("private upstream details");
  });
});
