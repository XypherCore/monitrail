import { describe, expect, it, vi } from "vitest";
import { createMonitorHandlers, type MonitorHttpAccess } from "./http.ts";
import { MonitorInputError } from "./input.ts";

const origin = "https://app.example.invalid";
const endpoint = `${origin}/api/monitors`;
const id = "11111111-1111-4111-8111-111111111111";
const input = {
  name: "Fixture monitor",
  url: "https://target.example.invalid/?token=synthetic-url-credential",
  intervalSeconds: 300,
  expectedStatus: "2xx",
};
const rejectedUrl = new Error("Private DNS detail");
const validationLimit = new Error("Private quota detail");
const brokenMapper = new Error("Private error translation detail");

function fixture() {
  const access = {
    createMonitor: vi.fn<MonitorHttpAccess["createMonitor"]>().mockResolvedValue({ id }),
    editMonitor: vi.fn<MonitorHttpAccess["editMonitor"]>().mockResolvedValue(true),
    setMonitorPaused: vi.fn<MonitorHttpAccess["setMonitorPaused"]>().mockResolvedValue(true),
    replaceMonitorChannels: vi.fn<MonitorHttpAccess["replaceMonitorChannels"]>().mockResolvedValue(true),
    deleteMonitor: vi.fn<MonitorHttpAccess["deleteMonitor"]>().mockResolvedValue(true),
  };
  const authenticate = vi.fn<() => Promise<MonitorHttpAccess | null>>().mockResolvedValue(access);
  const handlers = createMonitorHandlers({
    authenticate,
    origin: () => origin,
    mapError(error) {
      if (error instanceof MonitorInputError)
        return { status: 400, field: error.field, message: error.message };
      if (error === rejectedUrl)
        return { status: 400, field: "url", message: "This address is not allowed." };
      if (error === validationLimit)
        return { status: 429, message: "URL validation limit reached.", retryAfterSeconds: 90 };
      if (error === brokenMapper) throw brokenMapper;
      return null;
    },
  });
  return { handlers, authenticate, access };
}

function write(method: string, body?: BodyInit, overrides: Record<string, string> = {}) {
  return new Request(endpoint, {
    method,
    headers: { origin, "content-type": "application/json", ...overrides },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("monitor mutation boundary", () => {
  it("dispatches validated writes and returns only IDs in private responses", async () => {
    const { handlers, access } = fixture();
    // A runtime projection must still strip extra fields even if a dependency is widened.
    const result = { id, url: input.url, ownerId: "fixture-owner" };
    access.createMonitor.mockResolvedValueOnce(result);
    const { url, ...edit } = input;
    const created = await handlers.create(write("POST", JSON.stringify(input)));
    const edited = await handlers.update(write("PATCH", JSON.stringify(edit)), id);
    const paused = await handlers.update(write("PATCH", '{"isPaused":true}'), id);
    const resumed = await handlers.update(write("PATCH", '{"isPaused":false}'), id);
    const deleted = await handlers.delete(write("DELETE"), id);
    expect(access.createMonitor).toHaveBeenCalledWith({ ...edit, url });
    expect(access.editMonitor).toHaveBeenCalledWith(id, edit);
    expect(access.setMonitorPaused.mock.calls).toEqual([
      [id, true],
      [id, false],
    ]);
    expect(access.deleteMonitor).toHaveBeenCalledWith(id);
    expect(created.status).toBe(201);
    for (const response of [edited, paused, resumed, deleted]) expect(response.status).toBe(200);
    for (const response of [created, edited, paused, resumed, deleted]) {
      expect(await response.json()).toEqual({ id });
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("vary")).toBe("Cookie");
    }
  });

  it.each([undefined, "null", "https://app.example.invalid.evil.invalid", `${origin}:444`])(
    "rejects mismatched Origin %s before authenticating",
    async (requestOrigin) => {
      const { handlers, authenticate } = fixture();
      const headers: Record<string, string> = { "x-forwarded-host": "app.example.invalid" };
      if (requestOrigin !== undefined) headers.origin = requestOrigin;
      function request(method: string) {
        return new Request(endpoint, { method, headers });
      }
      const responses = await Promise.all([
        handlers.create(request("POST")),
        handlers.update(request("PATCH"), id),
        handlers.delete(request("DELETE"), id),
      ]);
      expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
      expect(authenticate).not.toHaveBeenCalled();
    },
  );

  it("requires the session before parsing mutation payloads and rejects unsupported methods", async () => {
    const { handlers, authenticate, access } = fixture();
    const invalidMethod = await handlers.create(new Request(endpoint));
    expect(invalidMethod.status).toBe(405);
    expect(invalidMethod.headers.get("allow")).toBe("POST");
    expect(authenticate).not.toHaveBeenCalled();

    authenticate.mockResolvedValue(null);
    const responses = await Promise.all([
      handlers.create(write("POST", "{")),
      handlers.update(write("PATCH", "{"), id),
      handlers.delete(write("DELETE"), id),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401]);
    expect(access.createMonitor).not.toHaveBeenCalled();
    expect(access.editMonitor).not.toHaveBeenCalled();
    expect(access.deleteMonitor).not.toHaveBeenCalled();
  });

  it("returns one 404 shape for malformed, absent, and foreign IDs", async () => {
    const { handlers, access } = fixture();
    access.editMonitor.mockResolvedValue(false);
    access.setMonitorPaused.mockResolvedValue(false);
    access.deleteMonitor.mockResolvedValue(false);
    const responses = await Promise.all([
      handlers.update(write("PATCH", "{"), "invalid-id"),
      handlers.update(write("PATCH", JSON.stringify(input)), id),
      handlers.update(write("PATCH", '{"isPaused":true}'), id),
      handlers.delete(write("DELETE"), id),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(await Promise.all(responses.map((response) => response.text()))).size).toBe(1);
    expect(access.editMonitor.mock.calls).toEqual([[id, input]]);
  });

  it("does not accept ownership, lifecycle, or configuration metadata from the caller", async () => {
    const { handlers, access } = fixture();
    const forged = { ...input, userId: "fixture-owner", configRev: 99, isPaused: false };
    expect((await handlers.create(write("POST", JSON.stringify(forged)))).status).toBe(400);
    expect((await handlers.update(write("PATCH", JSON.stringify(forged)), id)).status).toBe(400);
    expect(access.createMonitor).not.toHaveBeenCalled();
    expect(access.editMonitor).not.toHaveBeenCalled();
    expect(access.setMonitorPaused).not.toHaveBeenCalled();
  });

  it("authenticates and bounds subscription writes without reflecting private fields", async () => {
    const { handlers, access, authenticate } = fixture();
    const writeSelection = (value: unknown) => write("PUT", JSON.stringify(value));
    const badOrigin = await handlers.subscriptions(
      write("PUT", "{}", { origin: "https://other.example.invalid" }), id,
    );
    expect(badOrigin.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
    authenticate.mockResolvedValueOnce(null);
    expect((await handlers.subscriptions(writeSelection({ channelIds: [] }), id)).status).toBe(401);
    expect((await handlers.subscriptions(writeSelection({ channelIds: [], userId: id }), id)).status)
      .toBe(400);
    expect(access.replaceMonitorChannels).not.toHaveBeenCalled();

    const saved = await handlers.subscriptions(writeSelection({ channelIds: [id] }), id);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ id });
    expect(saved.headers.get("cache-control")).toContain("no-store");
    expect(access.replaceMonitorChannels).toHaveBeenCalledWith(id, [id]);

    access.replaceMonitorChannels.mockResolvedValueOnce(false);
    const missing = await handlers.subscriptions(writeSelection({ channelIds: [] }), id);
    const malformed = await handlers.subscriptions(writeSelection({ channelIds: [] }), "invalid");
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(await missing.json()).toEqual(await malformed.json());
  });

  it.each([
    ["text/plain", "identity"],
    ["application/json; charset=latin1", "identity"],
    ["application/json", "gzip"],
  ])("rejects unsupported media types and encoding", async (type, encoding) => {
    const { handlers, access } = fixture();
    const response = await handlers.create(
      write("POST", JSON.stringify(input), {
        "content-type": type,
        "content-encoding": encoding,
      }),
    );
    expect(response.status).toBe(415);
    expect(access.createMonitor).not.toHaveBeenCalled();
  });

  it("bounds the advertised length and actual stream, then cancels an oversized body", async () => {
    const { handlers, access } = fixture();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          controller.enqueue(new Uint8Array(5000));
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    expect((await handlers.create(write("POST", stream, { "content-length": "32" }))).status).toBe(
      413,
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect((await handlers.create(write("POST", "{}", { "content-length": "9000" }))).status).toBe(
      413,
    );
    expect((await handlers.create(write("POST", "{}", { "content-length": "2, 2" }))).status).toBe(
      400,
    );
    expect(
      (await handlers.create(write("POST", JSON.stringify(input), { "content-length": "4" })))
        .status,
    ).toBe(400);
    expect(access.createMonitor).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid UTF-8 without reflecting the body", async () => {
    const { handlers, access } = fixture();
    const response = await handlers.create(write("POST", "{synthetic-body-credential"));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("synthetic-body-credential");
    expect((await handlers.create(write("POST", new Uint8Array([0x7b, 0xff, 0x7d])))).status).toBe(
      400,
    );
    expect(access.createMonitor).not.toHaveBeenCalled();
  });

  it("bounds stalled uploads independently of reader cancellation", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, access } = fixture();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      });
      const response = handlers.create(write("POST", body));
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await response).status).toBe(408);
      expect(cancel).toHaveBeenCalledOnce();
      expect(access.createMonitor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes allowlisted messages and Retry-After while hiding dependency exceptions", async () => {
    const { handlers, access } = fixture();
    access.createMonitor
      .mockRejectedValueOnce(rejectedUrl)
      .mockRejectedValueOnce(validationLimit)
      .mockRejectedValueOnce(new Error("postgresql://synthetic-credential"))
      .mockRejectedValueOnce(brokenMapper);
    const rejected = await handlers.create(write("POST", JSON.stringify(input)));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: { field: "url", message: "This address is not allowed." },
    });
    const limited = await handlers.create(write("POST", JSON.stringify(input)));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("90");
    const unavailable = await handlers.create(write("POST", JSON.stringify(input)));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain("synthetic-credential");
    expect(unavailable.headers.get("cache-control")).toContain("no-store");
    const unmapped = await handlers.create(write("POST", JSON.stringify(input)));
    expect(unmapped.status).toBe(503);
    expect(await unmapped.text()).not.toContain(brokenMapper.message);
  });
});
