import { afterEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "../../shared/ssrf/io.ts";
import worker from "./index.ts";
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
