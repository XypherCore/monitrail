import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDohResolver } from "./dns.ts";

type RecordData = { name: string; type: number; TTL: number; data: string };
const host = "public.example";
const failureMessage = "DNS validation failed.";

function packet(name: string, type: number, answer?: RecordData[]) {
  return {
    Status: 0, TC: false, RD: true, RA: true, AD: false, CD: false,
    Question: [{ name: `${name}.`, type }],
    ...(answer === undefined ? {} : { Answer: answer }),
  };
}
function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/dns-json" } });
}
function rr(name: string, type: number, data: string): RecordData { return { name: `${name}.`, type, TTL: 60, data }; }
function query(input: string): { name: string; type: 1 | 28 } {
  const url = new URL(input);
  return { name: url.searchParams.get("name") ?? "", type: url.searchParams.get("type") === "A" ? 1 : 28 };
}
function fixture() {
  const transport = vi.fn<(input: string, init: RequestInit) => Promise<Response>>().mockImplementation(async input => {
    const { name, type } = query(input);
    return response(packet(name, type, [rr(name, type, type === 1 ? "1.1.1.1" : "2606:4700:4700::1111")]));
  });
  return { transport, resolve: createDohResolver(transport), controller: new AbortController() };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in isolated DNS test."); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("fixed-endpoint JSON DNS-over-HTTPS", () => {
  it("queries A and AAAA separately with clean, nonredirecting requests and no cache", async () => {
    const f = fixture();
    expect([...(await f.resolve("PUBLIC.EXAMPLE.", { signal: f.controller.signal }))].sort()).toEqual(["1.1.1.1", "2606:4700:4700::1111"]);
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(f.transport.mock.calls.map(([input]) => new URL(input).searchParams.get("type")).sort()).toEqual(["A", "AAAA"]);
    for (const [input, init] of f.transport.mock.calls) {
      const url = new URL(input);
      expect(url.origin + url.pathname).toBe("https://cloudflare-dns.com/dns-query");
      expect(url.searchParams.get("name")).toBe(host);
      expect(url.searchParams.get("cd")).toBe("false");
      expect(init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", cache: "no-store" });
      expect([...new Headers(init.headers)]).toEqual([["accept", "application/dns-json"]]);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("starts both address families concurrently", async () => {
    const f = fixture();
    const complete = new Map<number, (value: Response) => void>();
    f.transport.mockImplementation(input => new Promise(resolve => complete.set(query(input).type, resolve)));
    const pending = f.resolve(host, { signal: f.controller.signal });
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
    complete.get(1)?.(response(packet(host, 1, [rr(host, 1, "1.1.1.1")])));
    complete.get(28)?.(response(packet(host, 28)));
    expect(await pending).toEqual(["1.1.1.1"]);
  });

  it.each([1, 28])("accepts one family's NOERROR/NODATA when family %i has a usable answer", async usable => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      return response(packet(name, type, type === usable ? [rr(name, type, type === 1 ? "1.1.1.1" : "2606:4700:4700::1111")] : undefined));
    });
    expect(await f.resolve(host, { signal: f.controller.signal })).toEqual([usable === 1 ? "1.1.1.1" : "2606:4700:4700::1111"]);
  });

  it("returns all valid address records, including unsafe ones, for the guard to reject", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      return response(packet(name, type, type === 1 ? [rr(name, 1, "1.1.1.1"), rr(name, 1, "127.0.0.1")] : [rr(name, 28, "::1")]));
    });
    expect([...(await f.resolve(host, { signal: f.controller.signal }))].sort()).toEqual(["1.1.1.1", "127.0.0.1", "::1"]);
  });

  it("does not cache answers between calls", async () => {
    const f = fixture();
    await f.resolve(host, { signal: f.controller.signal });
    await f.resolve(host, { signal: f.controller.signal });
    expect(f.transport).toHaveBeenCalledTimes(4);
  });

  it("accepts unsigned DNS and mixed-case/root-dot names without requiring AD", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { type } = query(input);
      return response(packet("PUBLIC.EXAMPLE", type, [rr("PuBlIc.ExAmPlE", type, type === 1 ? "1.1.1.1" : "2606:4700:4700::1111")]));
    });
    expect(await f.resolve(host, { signal: f.controller.signal })).toHaveLength(2);
  });
});

describe("DNS status, schema and record validation", () => {
  it.each(["Status", "TC", "RD", "RA", "AD", "CD", "Question"])("rejects missing %s rather than treating it as a successful answer", async key => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      const value: Record<string, unknown> = packet(name, type, [rr(name, type, type === 1 ? "1.1.1.1" : "::1")]);
      delete value[key];
      return response(value);
    });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it.each([{ Status: 2 }, { Status: 3 }, { Status: "0" }, { TC: true }, { CD: true }, { AD: "false" }, { RD: null }, { Answer: null }, { Question: [] }, { Question: [{ name: "other.example.", type: 1 }] }])("rejects malformed or unsuccessful resolver payload: %j", async override => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      return response({ ...packet(name, type, [rr(name, type, type === 1 ? "1.1.1.1" : "::1")]), ...override });
    });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it("rejects a contradictory NXDOMAIN in one family even if the other returns addresses", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      return response(type === 1 ? packet(name, type, [rr(name, type, "1.1.1.1")]) : { ...packet(name, type), Status: 3 });
    });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it("rejects NODATA for both families", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => { const { name, type } = query(input); return response(packet(name, type)); });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it.each(["127.1", "0x7f000001", "01.1.1.1", "256.1.1.1", "private.example", "1.1.1.1 "])("rejects a noncanonical or invalid A record: %s", async data => {
    const f = fixture();
    f.transport.mockImplementation(async input => { const { name, type } = query(input); return response(packet(name, type, type === 1 ? [rr(name, type, data)] : undefined)); });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it.each(["[::1]", "fe80::1%eth0", "1.1.1.1", "not-an-address", "::gg"])("rejects an invalid AAAA record: %s", async data => {
    const f = fixture();
    f.transport.mockImplementation(async input => { const { name, type } = query(input); return response(packet(name, type, type === 28 ? [rr(name, type, data)] : undefined)); });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it("rejects mismatched question/answer families and unrelated address owners", async () => {
    for (const bad of [rr(host, 28, "::1"), rr("unrelated.example", 1, "1.1.1.1")]) {
      const f = fixture();
      f.transport.mockImplementation(async input => { const { name, type } = query(input); return response(packet(name, type, type === 1 ? [bad] : undefined)); });
      await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    }
    const f = fixture();
    f.transport.mockImplementation(async input => response(packet(host, query(input).type === 1 ? 28 : 1)));
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });
});

describe("rooted and bounded CNAME chains", () => {
  it("uses fully resolved chains without another A query and follows an AAAA alias to valid NODATA", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      if (name === host) return response(packet(name, type, [rr(host, 5, "EDGE.EXAMPLE."), rr("edge.example", 5, "terminal.example."), ...(type === 1 ? [rr("terminal.example", 1, "1.1.1.1")] : [])]));
      expect(name).toBe("terminal.example");
      expect(type).toBe(28);
      return response(packet(name, type));
    });
    expect(await f.resolve(host, { signal: f.controller.signal })).toEqual(["1.1.1.1"]);
    expect(f.transport).toHaveBeenCalledTimes(3);
  });

  it("resolves a CNAME-only answer within the same abort budget", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      if (type === 28) return response(packet(name, type));
      return response(packet(name, type, name === host ? [rr(host, 5, "edge.example.")] : [rr(name, 1, "1.1.1.1")]));
    });
    expect(await f.resolve(host, { signal: f.controller.signal })).toEqual(["1.1.1.1"]);
    expect(f.transport).toHaveBeenCalledTimes(3);
  });

  it.each([
    [rr(host, 5, "edge.example."), rr("edge.example", 5, `${host}.`)],
    [rr(host, 5, "one.example."), rr(host, 5, "two.example."), rr("one.example", 1, "1.1.1.1")],
    [rr(host, 5, "edge.example."), rr(host, 1, "1.1.1.1")],
    [rr("unrelated.example", 5, "edge.example."), rr(host, 1, "1.1.1.1")],
    [rr(host, 5, "service.internal."), rr("service.internal", 1, "1.1.1.1")],
  ])("rejects cycles, conflicting or unrelated CNAME records: %j", async (...answer) => {
    const f = fixture();
    f.transport.mockImplementation(async input => { const { name, type } = query(input); return response(packet(name, type, type === 1 ? answer : undefined)); });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });

  it("detects cycles spanning separate DoH answers", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      return response(packet(name, type, type === 1 ? [rr(name, 5, name === host ? "edge.example." : `${host}.`)] : undefined));
    });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    expect(f.transport.mock.calls.filter(([input]) => query(input).type === 1)).toHaveLength(2);
  });

  it("bounds unresolved aliases to four queries per family", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      const { name, type } = query(input);
      return response(packet(name, type, type === 1 ? [rr(name, 5, `${name === host ? "step" : name.split(".")[0]}-next.example.`)] : undefined));
    });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    expect(f.transport.mock.calls.filter(([input]) => query(input).type === 1)).toHaveLength(4);
  });

  it("bounds CNAME edges even when one response contains the whole chain", async () => {
    const f = fixture();
    const answer = Array.from({ length: 17 }, (_, index) => rr(index === 0 ? host : `edge-${index}.example`, 5, `edge-${index + 1}.example.`));
    answer.push(rr("edge-17.example", 1, "1.1.1.1"));
    f.transport.mockImplementation(async input => { const { name, type } = query(input); return response(packet(name, type, type === 1 ? answer : undefined)); });
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
  });
});

describe("DNS transport bounds and safe failures", () => {
  it.each([302, 404, 500])("rejects HTTP %i and never follows a resolver redirect", async status => {
    const f = fixture();
    f.transport.mockResolvedValue(new Response(null, { status, headers: { location: "https://untrusted.example/dns" } }));
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    expect(f.transport.mock.calls.every(([, init]) => init.redirect === "manual")).toBe(true);
    expect(f.transport.mock.calls.every(([input]) => new URL(input).origin === "https://cloudflare-dns.com")).toBe(true);
  });

  it("rejects invalid JSON, non-JSON content types and oversized resolver bodies", async () => {
    for (const value of [new Response("not JSON", { headers: { "content-type": "application/dns-json" } }), new Response(JSON.stringify(packet(host, 1)), { headers: { "content-type": "text/html" } })]) {
      const f = fixture();
      f.transport.mockImplementation(async () => value.clone());
      await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    }
    const f = fixture();
    const cancel = vi.fn();
    f.transport.mockImplementation(async input => query(input).type === 1 ? new Response(new ReadableStream({ type: "bytes", pull(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel }, { highWaterMark: 0 }), { headers: { "content-type": "application/dns-json" } }) : response(packet(host, 28)));
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["fetch", "body"])("honors abort even when resolver %s ignores its signal", async stage => {
    const f = fixture();
    f.transport.mockImplementation(async () => stage === "fetch" ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ type: "bytes", pull() { return new Promise<void>(() => {}); } }), { headers: { "content-type": "application/dns-json" } }));
    const pending = f.resolve(host, { signal: f.controller.signal });
    const rejected = expect(pending).rejects.toThrow(failureMessage);
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
    f.controller.abort(new Error("fixture cancellation detail"));
    await rejected;
    expect(f.transport.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
  });

  it("does not issue any query after a pre-aborted signal", async () => {
    const f = fixture();
    f.controller.abort();
    await expect(f.resolve(host, { signal: f.controller.signal })).rejects.toThrow(failureMessage);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it("cancels the sibling family and exposes only a fixed error after transport failure", async () => {
    const f = fixture();
    f.transport.mockImplementation(async input => {
      if (query(input).type === 1) throw new Error("fixture resolver infrastructure detail");
      return new Promise<Response>(() => {});
    });
    const rejected = await f.resolve(host, { signal: f.controller.signal }).catch(value => value);
    expect(String(rejected)).toBe(`Error: ${failureMessage}`);
    expect(rejected.stack).not.toContain("fixture resolver infrastructure detail");
    expect(f.transport.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
  });
});
