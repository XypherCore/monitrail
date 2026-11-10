import { checkerUserAgent } from "../../shared/identity.ts";
import { createWorkerGuard } from "../../shared/ssrf/index.ts";
import type { WorkerCheckResult } from "../../shared/ssrf/worker.ts";
import { runCheckTick } from "../src/tick.ts";

const target = "https://public.example/";
const appUrl = "https://monitor.example";
const userAgent = checkerUserAgent(appUrl);

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function fixture(targetResponse: () => Response) {
  const targetSignals: Array<AbortSignal | null | undefined> = [];
  async function transport(input: string, init: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    requireCondition(
      request.method === "GET" && request.redirect === "manual" && request.cache === "no-store",
      "Unexpected native request options.",
    );
    requireCondition(
      request.url === target && request.headers.get("User-Agent") === userAgent,
      "Unexpected target request.",
    );
    targetSignals.push(init.signal);
    return targetResponse();
  }
  return {
    guard: createWorkerGuard({ appUrl, blocklist: [], fetch: transport }),
    targetSignals,
  };
}

function requireBlocked(result: WorkerCheckResult): void {
  requireCondition(
    "errorType" in result && result.errorType === "blocked",
    "Expected blocked result.",
  );
}

export const capsNativeByteStream = {
  async test() {
    let delivered = 0;
    let canceled = false;
    const { guard, targetSignals } = fixture(() => {
      const stream = new ReadableStream({
        type: "bytes",
        pull(controller) {
          const request = controller.byobRequest;
          requireCondition(
            request?.view && delivered + request.view.byteLength <= 65536,
            "Native read exceeded the byte budget.",
          );
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
    });
    const result = await guard.check("https://PUBLIC.example./#discard");
    requireCondition(
      "statusCode" in result && result.statusCode === 200 && Object.keys(result).length === 3,
      "Unexpected check result.",
    );
    requireCondition(
      delivered === 65536 && canceled && targetSignals.length === 1 && targetSignals[0]?.aborted,
      "Body must stop at cap and target signal must be aborted.",
    );
  },
};

export const rejectsBlockedHosts = {
  async test() {
    let called = false;
    const guard = createWorkerGuard({
      appUrl,
      blocklist: [{ host: "example.com", includeSubdomains: true }],
      async fetch() {
        called = true;
        throw new Error("Unexpected fixture fetch.");
      },
    });
    requireBlocked(await guard.check("https://sub.EXAMPLE.com./"));
    requireBlocked(await guard.check("http://localhost/"));
    requireBlocked(await guard.check("http://192.168.1.1/"));
    requireBlocked(await guard.check("http://169.254.169.254/"));
    requireBlocked(await guard.check("http://[::ffff:169.254.169.254]/"));
    requireCondition(!called, "Policy denial must precede target fetching.");
  },
};

export const rejectsUnsafeRedirect = {
  async test() {
    const { guard, targetSignals } = fixture(() => Response.redirect("http://0xa9fea9fe/"));
    requireBlocked(await guard.check(target));
    requireCondition(
      targetSignals.length === 1 && targetSignals[0]?.aborted,
      "Original request must be cleaned up without fetching private redirect.",
    );
  },
};

export const preservesReceivedHeaders = {
  async test() {
    const { guard } = fixture(
      () =>
        new Response(
          new ReadableStream({
            type: "bytes",
            pull() {
              throw new Error("Synthetic body failure.");
            },
          }),
          { status: 503 },
        ),
    );
    const result = await guard.check(target);
    requireCondition(
      "statusCode" in result && result.statusCode === 503 && result.redirectCount === 0,
      "Body failure must preserve received headers.",
    );
  },
};

export const checksNativeFetch = {
  async test() {
    // The isolate dispatches global fetch only to the fixed offline fixture.
    // The fixture has no DNS endpoint and no outbound network capability.
    const url = "https://public.example/body";
    const response = await fetch(url, { headers: { "User-Agent": userAgent } });
    requireCondition(response.body, "Native fixture must have a body.");
    const reader = response.body.getReader({ mode: "byob" });
    try {
      const chunk = await reader.read(new Uint8Array(3));
      requireCondition(
        !chunk.done && chunk.value.byteLength === 3,
        "Native fetch must support bounded BYOB.",
      );
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const guard = createWorkerGuard({ appUrl, blocklist: [], fetch });
    const result = await guard.check(url);
    requireCondition(
      "statusCode" in result &&
        result.statusCode === 200 &&
        result.responseMs >= 0 &&
        result.responseMs <= 10000,
      "Unexpected native result.",
    );
    requireBlocked(await guard.check("https://public.example/redirect"));
    const overLimit = await guard.check("https://public.example/chain/0");
    requireBlocked(overLimit);
    requireCondition(overLimit.redirectCount === 2, "Worker may follow at most two redirects.");
  },
};

export const runsSignedTickThroughNativeFetch = {
  async test() {
    const metrics = await runCheckTick(
      { APP_URL: appUrl, INTERNAL_HMAC_SECRET: "synthetic-offline-worker-test-secret" },
      { now: () => Date.parse("2026-11-08T00:00:12.000Z") },
    );
    requireCondition(
      metrics.outcome === "completed" &&
        metrics.jobs === 2 &&
        metrics.subrequests === 3 &&
        metrics.accepted === 2 &&
        metrics.maxSlotLatenessMs === 12000,
      "Expected signed claim, one permitted target, and signed ingest.",
    );
  },
};
