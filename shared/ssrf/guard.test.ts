import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSsrfGuard, SsrfError } from "./guard.ts";

type Options = { signal: AbortSignal };
const target = "https://public.example/path";
const userAgent = "Monitrail/1.0 (+https://app.example.invalid/bot)";
const publicAddresses = ["1.1.1.1", "2606:4700:4700::1111"];

function fixture() {
  const resolve = vi.fn<(host: string, options: Options) => Promise<readonly string[]>>().mockResolvedValue(publicAddresses);
  const isBlockedHost = vi.fn<(host: string, options: Options) => Promise<boolean>>().mockResolvedValue(false);
  const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>().mockImplementation(async () => new Response(null, { status: 200 }));
  return { resolve, isBlockedHost, fetch, guard: createSsrfGuard({ resolve, isBlockedHost, fetch, userAgent }) };
}

beforeEach(() => {
  // Tests must never reach a real resolver or monitored target, even if an
  // implementation accidentally ignores its injected network dependency.
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in isolated guard test."); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SSRF URL policy and address validation", () => {
  it.each([
    "file:///etc/passwd", "ftp://public.example/file", "gopher://public.example", "data:text/plain,fixture",
    "javascript:fixture", "//public.example", "not a URL", "https://user:pass@public.example", "https://@public.example",
    "https://user@public.example", "https://%75ser%3Apass@public.example", "http://127.0.0.1\\@public.example",
    "http://localhost", "http://LOCALHOST.", "http://a.localhost", "http://a.local", "http://a.internal",
    "http://singlelabel", "http://metadata.google.internal", "https://public.example:0", "https://public.example:22",
    "https://public.example:3000", "https://public.example:65535", "http://[fe80::1%25eth0]",
  ])("rejects forbidden URL syntax, host or port before target fetching: %s", async input => {
    const f = fixture();
    await expect(f.guard.validate(input)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each([
    "http://0.0.0.0", "http://0.1.2.3", "http://10.1.2.3", "http://100.64.0.1", "http://100.127.255.254",
    "http://127.0.0.1", "http://169.254.169.254", "http://169.254.169.253", "http://172.16.0.1", "http://172.31.255.254",
    "http://192.168.1.1", "http://192.0.0.1", "http://192.0.2.1", "http://192.168.0.1", "http://198.18.0.1",
    "http://198.19.255.254", "http://198.51.100.1", "http://203.0.113.1", "http://224.0.0.1", "http://239.255.255.254",
    "http://240.0.0.1", "http://255.255.255.255", "http://168.63.129.16", "http://100.100.100.200",
    "http://127.1", "http://2130706433", "http://0177.0.0.1", "http://0x7f000001", "http://0x7f.0.0.1",
    "http://[::]", "http://[::1]", "http://[fc00::1]", "http://[fd00:ec2::254]", "http://[fe80::1]", "http://[ff02::1]",
    "http://[2001:db8::1]", "http://[::ffff:127.0.0.1]", "http://[::ffff:7f00:1]", "http://[::ffff:192.168.0.1]",
    "http://[::7f00:1]", "http://[64:ff9b::7f00:1]", "http://[2002:7f00:1::]",
  ])("rejects private, metadata, reserved and embedded address forms: %s", async input => {
    const f = fixture();
    await expect(f.guard.check(input)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  it.each([
    "http://public.example", "https://public.example", "http://public.example:8080", "https://public.example:8443",
    "https://public.example:80", "http://public.example:443", "http://16843009", "https://1.1.1.1", "https://[2606:4700:4700::1111]",
    "https://public.example/path@label?contact=fixture@example.invalid",
  ])("accepts a public target and permitted port: %s", async input => {
    const f = fixture();
    expect(await f.guard.validate(input)).toEqual({ url: new URL(input).href });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("normalizes casing and default ports, and checks literals without DNS", async () => {
    const f = fixture();
    expect(await f.guard.validate("HTTPS://PUBLIC.EXAMPLE:443/path")).toEqual({ url: target });
    expect(f.resolve).toHaveBeenCalledWith("public.example", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    f.resolve.mockClear();
    await f.guard.check("https://1.1.1.1/");
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.isBlockedHost).toHaveBeenCalledWith("1.1.1.1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"])("rejects DNS if any answer is unsafe: %s", async address => {
    const f = fixture();
    f.resolve.mockResolvedValue(["1.1.1.1", address]);
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it.each([["1.1.1.1"], ["2606:4700:4700::1111"], publicAddresses])("accepts public IPv4-only, IPv6-only and dual-stack DNS results: %j", async (...addresses) => {
    const f = fixture();
    f.resolve.mockResolvedValue(addresses);
    expect(await f.guard.check(target)).toEqual({ statusCode: 200 });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("fails closed for empty, malformed and failed DNS resolution", async () => {
    for (const addresses of [[], ["not-an-address"]]) {
      const f = fixture();
      f.resolve.mockResolvedValue(addresses);
      await expect(f.guard.check(target)).rejects.toBeInstanceOf(SsrfError);
      expect(f.fetch).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.resolve.mockRejectedValue(new Error("fixture DNS infrastructure detail"));
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "dns" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("rechecks DNS and the blocklist when validation is followed by a check", async () => {
    const f = fixture();
    await f.guard.validate(target);
    f.resolve.mockResolvedValue(["127.0.0.1"]);
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(f.fetch).not.toHaveBeenCalled();
    const blocked = fixture();
    await blocked.guard.validate(target);
    blocked.isBlockedHost.mockResolvedValue(true);
    await expect(blocked.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(blocked.fetch).not.toHaveBeenCalled();
  });

  it("fails closed if the blocklist is unavailable or returns an invalid decision", async () => {
    const f = fixture();
    f.isBlockedHost.mockRejectedValue(new Error("fixture database detail"));
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).not.toHaveBeenCalled();
    const malformed = fixture();
    malformed.isBlockedHost.mockResolvedValue(undefined as unknown as boolean);
    await expect(malformed.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(malformed.fetch).not.toHaveBeenCalled();
  });
});

describe("guarded target requests and manual redirects", () => {
  it.each([
    "unidentified", "Monitrail/1.0 (+https://@app.example.invalid/bot)",
    "Monitrail/1.0 (+https://app.example.invalid/bot?credential=fixture)",
    "Monitrail/1.0 (+https://app.example.invalid/bot)\r\n",
    "Monitrail/1.0 (+https:\\app.example.invalid\\bot)",
  ])("rejects an unsafe configured request identity: %j", identity => {
    const f = fixture();
    expect(() => createSsrfGuard({ ...f, userAgent: identity })).toThrow(SsrfError);
  });

  it("uses only a clean GET with explicit manual redirects, omitted credentials and no cache", async () => {
    const f = fixture();
    f.fetch.mockResolvedValue(new Response("fixture body must not escape", { status: 418, headers: { "x-fixture-secret": "fixture header must not escape" } }));
    const result = await f.guard.check(target);
    expect(result).toEqual({ statusCode: 418 });
    expect(Object.getOwnPropertyNames(result)).toEqual(["statusCode"]);
    expect(f.fetch).toHaveBeenCalledWith(target, expect.objectContaining({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", signal: expect.any(AbortSignal) }));
    const init = f.fetch.mock.calls[0][1];
    expect([...new Headers(init.headers)]).toEqual([["user-agent", userAgent]]);
    expect(init.body).toBeUndefined();
  });

  it("follows three redirects, cancels their bodies, and revalidates even the same hostname", async () => {
    const f = fixture();
    const cancels = [vi.fn(), vi.fn(), vi.fn()];
    for (let i = 0; i < 3; i++) {
      f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancels[i] }), { status: 302, headers: { location: `/hop-${i + 1}`, "set-cookie": "fixture=must-not-forward" } }));
    }
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect(await f.guard.check(target)).toEqual({ statusCode: 204 });
    expect(f.fetch.mock.calls.map(([url]) => url)).toEqual([target, "https://public.example/hop-1", "https://public.example/hop-2", "https://public.example/hop-3"]);
    expect(f.resolve).toHaveBeenCalledTimes(4);
    expect(f.isBlockedHost).toHaveBeenCalledTimes(4);
    for (const cancel of cancels) expect(cancel).toHaveBeenCalledOnce();
    for (const [, init] of f.fetch.mock.calls) expect([...new Headers(init.headers)]).toEqual([["user-agent", userAgent]]);
  });

  it("does not fetch a fifth target after a fourth redirect", async () => {
    const f = fixture();
    f.fetch.mockImplementation(async input => new Response(null, { status: 302, headers: { location: `${new URL(input).pathname}-next` } }));
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).toHaveBeenCalledTimes(4);
  });

  it.each(["http://127.0.0.1/", "http://169.254.169.254/", "http://[fd00:ec2::254]/", "file:///etc/passwd", "https://user:pass@public.example/", "https://public.example:3000/"])("rejects an unsafe redirect before contacting it: %s", async location => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a newly private DNS answer and a blocked hostname on redirect", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: "/again" } }));
    f.resolve.mockResolvedValueOnce(publicAddresses).mockResolvedValueOnce(["10.0.0.1"]);
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).toHaveBeenCalledOnce();
    const blocked = fixture();
    blocked.fetch.mockResolvedValueOnce(new Response(null, { status: 308, headers: { location: "https://blocked.example/" } }));
    blocked.isBlockedHost.mockImplementation(async host => host === "blocked.example");
    await expect(blocked.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(blocked.fetch).toHaveBeenCalledOnce();
  });

  it("checks canonical trailing-dot names against the blocklist", async () => {
    const f = fixture();
    f.isBlockedHost.mockImplementation(async host => host === "blocked.example");
    await expect(f.guard.check("https://BLOCKED.EXAMPLE./")).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("does not follow a 304 response as a redirect", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(null, { status: 304, headers: { location: "http://127.0.0.1/" } }));
    expect(await f.guard.check(target)).toEqual({ statusCode: 304 });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("rejects a redirect containing a control before URL parsing can erase userinfo", async () => {
    const f = fixture();
    const response = new Response(null, { status: 302 });
    vi.spyOn(response.headers, "get").mockReturnValue("\u0001https://@public.example/");
    f.fetch.mockResolvedValueOnce(response);
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "blocked" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("rejects a response from a transport that followed a redirect", async () => {
    const f = fixture();
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "redirected", "get").mockReturnValue(true);
    f.fetch.mockResolvedValueOnce(response);
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "connect" });
  });
});

describe("bounded response consumption and safe failures", () => {
  it.each([65536, 80000])("cancels at the 64KiB boundary without reading another transport chunk (%i bytes)", async length => {
    const f = fixture();
    const cancel = vi.fn();
    const pull = vi.fn((controller: ReadableByteStreamController) => controller.enqueue(new Uint8Array(length)));
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ type: "bytes", pull, cancel }, { highWaterMark: 0 }), { status: 200 }));
    expect(await f.guard.check(target)).toEqual({ statusCode: 200 });
    expect(pull).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it("cancels without reading when the stream cannot guarantee bounded byte reads", async () => {
    const f = fixture();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => controller.enqueue(new Uint8Array(80000)));
    const cancel = vi.fn();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 })));
    await expect(f.guard.check(target)).rejects.toMatchObject({ code: "connect" });
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not leak or log target URLs, headers, bodies or dependency exceptions", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    f.fetch.mockResolvedValueOnce(new Response("fixture response body detail", { headers: { "x-fixture-private": "fixture response header detail" } }));
    expect(await f.guard.check(target)).toEqual({ statusCode: 200 });
    f.fetch.mockRejectedValue(new Error("fixture transport detail and private-query-fixture"));
    const rejected = await f.guard.check("https://public.example/?token=private-query-fixture").catch(value => value);
    expect(rejected).toBeInstanceOf(SsrfError);
    expect(rejected.code).toBe("connect");
    expect(`${String(rejected)}${JSON.stringify(rejected)}${rejected.stack}`).not.toContain("private-query-fixture");
    expect(`${String(rejected)}${JSON.stringify(rejected)}`).not.toContain("fixture transport detail");
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("turns a response-stream failure into a fixed error without retaining response data", async () => {
    const f = fixture();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { controller.error(new Error("fixture stream infrastructure detail")); } })));
    const rejected = await f.guard.check(target).catch(value => value);
    expect(rejected).toBeInstanceOf(SsrfError);
    expect(`${String(rejected)}${JSON.stringify(rejected)}${rejected.stack}`).not.toContain("fixture stream infrastructure detail");
  });

  it.each(["blocklist", "dns", "fetch", "body"])("enforces a 10-second deadline even when %s ignores cancellation", async stage => {
    vi.useFakeTimers();
    const f = fixture();
    const never = () => new Promise<never>(() => {});
    if (stage === "blocklist") f.isBlockedHost.mockImplementation(never);
    if (stage === "dns") f.resolve.mockImplementation(never);
    if (stage === "fetch") f.fetch.mockImplementation(never);
    if (stage === "body") f.fetch.mockResolvedValue(new Response(new ReadableStream({ type: "bytes", pull: never, cancel: never })));
    const pending = f.guard.check(target);
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
  });

  it("cancels a response returned by the transport after the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    f.fetch.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 11000));
      return response;
    });
    const rejected = expect(f.guard.check(target)).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    await vi.advanceTimersByTimeAsync(1000);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses one total deadline across DNS and redirect hops rather than resetting per step", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.resolve.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 4000));
      return publicAddresses;
    });
    f.fetch.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 3000));
      return new Response(null, { status: 302, headers: { location: "/again" } });
    });
    const pending = f.guard.check(target);
    const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
