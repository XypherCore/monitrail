import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkerUserAgent } from "../identity.ts";
import type { BlockedHost } from "./blocklist.ts";
import type { Transport } from "./io.ts";
import { createWorkerGuard } from "./worker.ts";

const appUrl = "https://app.example";
const userAgent = () => checkerUserAgent(appUrl);
const initial = "https://public.example/";
const redirect = (location: string) =>
  new Response(null, { status: 302, headers: { Location: location } });

function fixture(blocklist: readonly BlockedHost[] = []) {
  const transport = vi.fn<Transport>();
  const guard = createWorkerGuard({ appUrl, blocklist, fetch: transport });
  return { transport, guard };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected unguarded fixture request.");
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Worker transport profile", () => {
  it("sums only request-to-headers time across at most two manual redirects", async () => {
    vi.useFakeTimers();
    const { transport, guard } = fixture();
    const scheduled = (ms: number, response: () => Response) => () =>
      new Promise<Response>((resolve) => setTimeout(() => resolve(response()), ms));
    const body = new ReadableStream({
      type: "bytes",
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.close();
        controller.byobRequest?.respond(0);
      },
    });
    transport
      .mockImplementationOnce(scheduled(20, () => redirect("/first")))
      .mockImplementationOnce(scheduled(40, () => redirect("https://other.example/second")))
      .mockImplementationOnce(scheduled(70, () => new Response(body, { status: 500 })));
    const check = guard.check(initial);
    await vi.runAllTimersAsync();
    expect(await check).toEqual({ statusCode: 500, responseMs: 130, redirectCount: 2 });
    expect(transport.mock.calls.map(([url]) => url)).toEqual([
      initial,
      "https://public.example/first",
      "https://other.example/second",
    ]);
    for (const [, options] of transport.mock.calls) {
      expect(options).toMatchObject({
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        headers: { "User-Agent": userAgent() },
      });
      expect(options.signal?.aborted).toBe(true);
    }
  });

  it("never follows a third redirect", async () => {
    const { transport, guard } = fixture();
    transport.mockImplementation(async () => redirect("/next"));
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "blocked", redirectCount: 2 });
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it.each([
    "http://169.254.169.254/",
    "http://127.1/",
    "http://[::ffff:7f00:1]/",
    "http://localhost/",
    "http://other.example:9000/",
    "http://u:p@other.example/",
    "https://a.BLOCKED.example./",
  ])("blocks an unsafe redirect without opening its connection: %s", async (location) => {
    const { transport, guard } = fixture([{ host: "blocked.example", includeSubdomains: true }]);
    transport.mockImplementation(async () => redirect(location));
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "blocked", redirectCount: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("blocks an initially disallowed hostname without opening a connection", async () => {
    const { transport, guard } = fixture([{ host: "PUBLIC.example.", includeSubdomains: true }]);
    await expect(guard.check("https://a.public.example/")).resolves.toEqual({
      errorType: "blocked",
      redirectCount: 0,
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "file:///etc/passwd",
    "ftp://public.example/",
    "https://@public.example/",
    "https://user:password@public.example/",
    "http://a.internal/",
    "http://singlelabel/",
    "http://0xa9fea9fe/",
    "http://[fd00:ec2::254]/",
    "https://public.example:22/",
  ])("applies static policy before the initial target request: %s", async (input) => {
    const { transport, guard } = fixture();
    await expect(guard.check(input)).resolves.toEqual({ errorType: "blocked", redirectCount: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rejects an invalid blocklist before any request and retains an independent snapshot", async () => {
    const transport = vi.fn<Transport>();
    expect(() =>
      createWorkerGuard({
        appUrl,
        fetch: transport,
        blocklist: [{ host: "public.example", includeSubdomains: undefined }] as never,
      }),
    ).toThrow("Invalid blocklist snapshot.");
    expect(transport).not.toHaveBeenCalled();
    const entries = [{ host: "public.example", includeSubdomains: true }];
    const guard = createWorkerGuard({ appUrl, fetch: transport, blocklist: entries });
    entries[0].host = "other.example";
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "blocked", redirectCount: 0 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("rechecks policy even on same-host redirects", async () => {
    const { transport, guard } = fixture();
    transport
      .mockResolvedValueOnce(redirect("/second"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(guard.check(initial)).resolves.toEqual({
      statusCode: 204,
      responseMs: expect.any(Number),
      redirectCount: 1,
    });
    expect(transport.mock.calls[1][0]).toBe("https://public.example/second");
  });

  it("does not send cookies or forward response headers at redirect hops", async () => {
    const { transport, guard } = fixture();
    transport
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            Location: "https://other.example/",
            "Set-Cookie": "credential=test-only",
            Authorization: "opaque-test-only",
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await guard.check(initial)).toEqual({
      statusCode: 204,
      responseMs: expect.any(Number),
      redirectCount: 1,
    });
    expect(transport.mock.calls[1][1].headers).toEqual({ "User-Agent": userAgent() });
  });

  it("classifies an opaque native fetch failure without returning details", async () => {
    const { transport, guard } = fixture();
    transport.mockRejectedValue(new TypeError("Sensitive fake URL and upstream diagnostic"));
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "connect", redirectCount: 0 });
  });

  it("never serializes or logs target query strings, bodies, headers or raw errors", async () => {
    const { transport, guard } = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    transport.mockResolvedValueOnce(
      new Response("fake sensitive body", {
        headers: { "x-private-fixture": "fake sensitive header" },
      }),
    );
    const result = await guard.check("https://public.example/?token=sensitive-fixture");
    expect(Object.keys(result).sort()).toEqual(["redirectCount", "responseMs", "statusCode"]);
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("never follows a malformed or missing Location but reports nonredirect 304", async () => {
    const { transport, guard } = fixture();
    transport
      .mockResolvedValueOnce(new Response(null, { status: 302 }))
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { Location: "/unused" } }));
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "blocked", redirectCount: 0 });
    await expect(guard.check(initial)).resolves.toEqual({
      statusCode: 304,
      responseMs: expect.any(Number),
      redirectCount: 0,
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("rejects Location control characters before parsing could erase empty userinfo", async () => {
    const { transport, guard } = fixture();
    const response = new Response(null, { status: 302 });
    vi.spyOn(response.headers, "get").mockReturnValue("\u0001https://@public.example/");
    transport.mockResolvedValueOnce(response);
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "blocked", redirectCount: 0 });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("rejects an automatically followed redirect or an invalid transport status", async () => {
    const { transport, guard } = fixture();
    const response = new Response(null);
    vi.spyOn(response, "redirected", "get").mockReturnValue(true);
    transport.mockResolvedValueOnce(response);
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "connect", redirectCount: 0 });
    transport.mockResolvedValueOnce(Response.error());
    await expect(guard.check(initial)).resolves.toEqual({ errorType: "connect", redirectCount: 0 });
  });

  it("enforces the deadline when the initial fetch ignores cancellation", async () => {
    vi.useFakeTimers();
    const { transport, guard } = fixture();
    transport.mockImplementation(() => new Promise<Response>(() => {}));
    const check = guard.check(initial);
    await vi.runAllTimersAsync();
    await expect(check).resolves.toEqual({ errorType: "timeout", redirectCount: 0 });
    expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it("uses a single deadline across hops and cancels a response arriving after it", async () => {
    vi.useFakeTimers();
    const { transport, guard } = fixture();
    const cancel = vi.fn();
    transport
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve(redirect("/next")), 6000)),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              const body = new ReadableStream({ type: "bytes", cancel });
              resolve(new Response(body));
            }, 5000),
          ),
      );
    const check = guard.check(initial);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(check).resolves.toEqual({ errorType: "timeout", redirectCount: 1 });
    await vi.runAllTimersAsync();
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport.mock.calls[1][1].signal?.aborted).toBe(true);
  });

  it("preserves final headers when body reading fails or misses the deadline", async () => {
    vi.useFakeTimers();
    const { transport, guard } = fixture();
    const broken = new ReadableStream({
      type: "bytes",
      pull() {
        throw new Error("fake sensitive body diagnostic");
      },
    });
    const stalled = new ReadableStream({
      type: "bytes",
      pull() {
        return new Promise<void>(() => {});
      },
    });
    transport.mockResolvedValueOnce(new Response(broken, { status: 202 }));
    transport.mockResolvedValueOnce(new Response(stalled, { status: 503 }));
    await expect(guard.check(initial)).resolves.toEqual({
      statusCode: 202,
      responseMs: 0,
      redirectCount: 0,
    });
    const check = guard.check(initial);
    await vi.runAllTimersAsync();
    await expect(check).resolves.toEqual({ statusCode: 503, responseMs: 0, redirectCount: 0 });
  });

  it("measures exactly the byte budget with native BYOB and returns no response material", async () => {
    const { transport, guard } = fixture();
    let delivered = 0;
    const cancel = vi.fn();
    const body = new ReadableStream({
      type: "bytes",
      pull(controller) {
        const request = controller.byobRequest;
        if (!request?.view) throw new Error("Expected BYOB");
        const length = Math.min(request.view.byteLength, 7000);
        delivered += length;
        request.respond(length);
      },
      cancel,
    });
    transport.mockResolvedValueOnce(
      new Response(body, { headers: { "x-fake-secret": "test-only" } }),
    );
    await expect(guard.check(initial)).resolves.toEqual({
      statusCode: 200,
      responseMs: expect.any(Number),
      redirectCount: 0,
    });
    expect(delivered).toBe(65536);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
