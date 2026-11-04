import { createMonitoringGuard, SsrfError } from "../../shared/ssrf/index.ts";

const target = "https://public.example/";
const userAgent = "Monitrail/1.0 (+https://monitrail.example/bot)";

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function dnsPacket(url: URL, ipv6: string): Response {
  const name = url.searchParams.get("name");
  const family = url.searchParams.get("type");
  requireCondition(
    url.pathname === "/dns-query" &&
      name === "public.example" &&
      (family === "A" || family === "AAAA"),
    "Unexpected DNS request.",
  );
  const type = family === "A" ? 1 : 28;
  return Response.json(
    {
      Status: 0,
      TC: false,
      RD: true,
      RA: true,
      AD: false,
      CD: false,
      Question: [{ name, type }],
      Answer: [{ name, type, TTL: 60, data: family === "A" ? "8.8.8.8" : ipv6 }],
    },
    { headers: { "content-type": "application/dns-json" } },
  );
}

function fixture(ipv6: string, targetResponse: () => Response) {
  const dnsFamilies = new Set<string | null>();
  const policyHosts: string[] = [];
  const targetSignals: Array<AbortSignal | null | undefined> = [];
  async function transport(input: string, init: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requireCondition(
      request.method === "GET" && request.redirect === "manual" && request.cache === "no-store",
      "Unexpected native request options.",
    );
    if (url.origin === "https://cloudflare-dns.com") {
      dnsFamilies.add(url.searchParams.get("type"));
      return dnsPacket(url, ipv6);
    }
    targetSignals.push(init.signal);
    requireCondition(
      request.url === target && request.headers.get("User-Agent") === userAgent,
      "Unexpected target request.",
    );
    return targetResponse();
  }
  return {
    guard: createMonitoringGuard({
      async isBlockedHost(host) {
        policyHosts.push(host);
        return false;
      },
      fetch: transport,
      userAgent,
    }),
    dnsFamilies,
    policyHosts,
    targetSignals,
  };
}

async function requireBlocked(check: Promise<unknown>): Promise<void> {
  try {
    await check;
  } catch (error) {
    if (error instanceof SsrfError && error.code === "blocked") return;
    throw error;
  }
  throw new Error("Expected the guard to block this check.");
}

export const capsNativeByteStream = {
  async test() {
    let delivered = 0;
    let canceled = false;
    const { guard, dnsFamilies, policyHosts, targetSignals } = fixture(
      "2606:4700:4700::1111",
      () => {
        const stream = new ReadableStream({
          type: "bytes",
          pull(controller) {
            const request = controller.byobRequest;
            requireCondition(
              request?.view && delivered + request.view.byteLength <= 65536,
              "Native read exceeded the byte budget.",
            );
            // Uneven chunks exercise the final BYOB read's reduced buffer.
            const length = Math.min(request.view.byteLength, 7000);
            request.view.fill(0, 0, length);
            delivered += length;
            request.respond(length);
          },
          cancel() {
            canceled = true;
          },
        });
        return new Response(stream, { status: 200, headers: { "X-Fixture": "discarded" } });
      },
    );
    const result = await guard.check("https://PUBLIC.example./#discard");
    requireCondition(
      result.statusCode === 200 && Object.keys(result).length === 1,
      "Unexpected check result.",
    );
    requireCondition(
      dnsFamilies.has("A") && dnsFamilies.has("AAAA"),
      "Both address families must be requested.",
    );
    requireCondition(
      policyHosts.join() === "public.example",
      "Policy must see the canonical hostname.",
    );
    requireCondition(
      delivered === 65536 && canceled && targetSignals.length === 1 && targetSignals[0]?.aborted,
      "The body must stop at the cap and the target signal must be aborted.",
    );
  },
};

export const rejectsUnsafeDns = {
  async test() {
    const { guard, dnsFamilies, targetSignals } = fixture(
      "::ffff:169.254.169.254",
      () => new Response(),
    );
    await requireBlocked(guard.check(target));
    requireCondition(
      dnsFamilies.has("A") && dnsFamilies.has("AAAA") && targetSignals.length === 0,
      "An unsafe address must block the target despite a public answer in the other family.",
    );
  },
};

export const rejectsUnsafeRedirect = {
  async test() {
    const { guard, targetSignals } = fixture("2606:4700:4700::1111", () =>
      Response.redirect("http://0xa9fea9fe/"),
    );
    await requireBlocked(guard.check(target));
    requireCondition(
      targetSignals.length === 1 && targetSignals[0]?.aborted,
      "The original request must be cleaned up without fetching the private redirect.",
    );
  },
};

export const checksNativeFetch = {
  async test() {
    // Global fetch in this test isolate routes exclusively to the fixed fixture.
    const url = "https://public.example/body";
    const response = await fetch(url, { headers: { "User-Agent": userAgent } });
    requireCondition(response.body, "Native fetch fixture must have a body.");
    const reader = response.body.getReader({ mode: "byob" });
    try {
      const chunk = await reader.read(new Uint8Array(3));
      requireCondition(
        !chunk.done && chunk.value.byteLength === 3,
        "Native fetch body must support bounded BYOB reads.",
      );
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }

    const guard = createMonitoringGuard({
      async isBlockedHost() {
        return false;
      },
      fetch,
      userAgent,
    });
    const result = await guard.check(url);
    requireCondition(result.statusCode === 200, "The guard must read the native fetch response.");
    await requireBlocked(guard.check("https://public.example/redirect"));
  },
};
