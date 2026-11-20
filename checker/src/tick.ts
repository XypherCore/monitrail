import {
  type CheckOutcome,
  type IngestRequest,
  MAX_CHECK_BATCH,
  parseClaimResponse,
  parseIngestResponse,
} from "../../shared/checks/protocol.ts";
import {
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_CLAIM_PATH,
  INTERNAL_INGEST_PATH,
  type InternalPath,
  isInternalSecret,
  signInternalRequest,
} from "../../shared/checks/signing.ts";
import { checkerUserAgent } from "../../shared/identity.ts";
import { awaitSignal, cancelBody, type Transport } from "../../shared/ssrf/io.ts";
import { createWorkerGuard } from "../../shared/ssrf/worker.ts";

export const CHECK_CRON = "* * * * *";
const PARALLEL_CHECKS = 6;
// The control requests cannot outlive the server's check lease.
export const LEASE_WINDOW_MS = 120_000;

export type CheckerEnv = Readonly<{
  APP_URL: string;
  INTERNAL_HMAC_SECRET: string;
}>;

type TickOutcome = "configuration_error" | "claim_error" | "idle" | "ingest_error" | "completed";
export type CheckTickMetrics = {
  outcome: TickOutcome;
  jobs: number;
  subrequests: number;
  maxSlotLatenessMs: number;
  accepted: number;
  dropped: number;
  errors: number;
};

export function applicationOrigin(appUrl: string): string {
  checkerUserAgent(appUrl);
  const url = new URL(appUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Invalid checker configuration.");
  }
  return url.origin;
}

export async function readControlJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || response.redirected || !response.body) {
    throw new Error("Internal request failed.");
  }
  const contentType = response.headers.get("content-type");
  const length = response.headers.get("content-length");
  if (
    contentType?.toLowerCase().split(";")[0].trim() !== "application/json" ||
    (length !== null && (!/^\d+$/.test(length) || Number(length) > INTERNAL_BODY_LIMIT_BYTES))
  ) {
    throw new Error("Invalid internal response.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { value, done } = await awaitSignal(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > INTERNAL_BODY_LIMIT_BYTES) throw new Error("Invalid internal response.");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* Cancellation cannot extend the control-request deadline. */
    }
    try {
      reader.releaseLock();
    } catch {
      /* The aborted read may still be settling. */
    }
  }
}

export async function runCheckTick(
  env: CheckerEnv,
  dependencies: Readonly<{ fetch?: Transport; now?: () => number }> = {},
): Promise<CheckTickMetrics> {
  const metrics: CheckTickMetrics = {
    outcome: "configuration_error",
    jobs: 0,
    subrequests: 0,
    maxSlotLatenessMs: 0,
    accepted: 0,
    dropped: 0,
    errors: 0,
  };
  let origin: string;
  try {
    origin = applicationOrigin(env.APP_URL);
    if (!isInternalSecret(env.INTERNAL_HMAC_SECRET)) return metrics;
  } catch {
    return metrics;
  }

  const transport = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const countedFetch: Transport = (input, init) => {
    metrics.subrequests++;
    return transport(input, init);
  };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), LEASE_WINDOW_MS);

  async function post(path: InternalPath, body: string): Promise<unknown> {
    const headers = await signInternalRequest(env.INTERNAL_HMAC_SECRET, path, body);
    if (deadline.signal.aborted) throw new Error("Internal request timed out.");
    const response = await awaitSignal(
      countedFetch(`${origin}${path}`, {
        method: "POST",
        headers,
        body,
        cache: "no-store",
        redirect: "manual",
        credentials: "omit",
        signal: deadline.signal,
      }).then((result) => {
        if (deadline.signal.aborted) cancelBody(result);
        return result;
      }),
      deadline.signal,
    );
    try {
      return await readControlJSON(response, deadline.signal);
    } finally {
      cancelBody(response);
    }
  }

  try {
    metrics.outcome = "claim_error";
    const claim = parseClaimResponse(
      await post(INTERNAL_CLAIM_PATH, JSON.stringify({ max: MAX_CHECK_BATCH })),
    );
    const guard = createWorkerGuard({
      appUrl: origin,
      blocklist: claim.blocklist.map(({ host, include_subdomains }) => ({
        host,
        includeSubdomains: include_subdomains,
      })),
      fetch: countedFetch,
    });
    metrics.jobs = claim.jobs.length;
    if (metrics.jobs === 0) {
      metrics.outcome = "idle";
      return metrics;
    }

    metrics.outcome = "ingest_error";
    metrics.errors = claim.jobs.length;
    const results: IngestRequest["results"] = [];
    let cursor = 0;
    async function checkNext() {
      for (let index = cursor++; index < claim.jobs.length; index = cursor++) {
        if (deadline.signal.aborted) return;
        const job = claim.jobs[index];
        const started = now();
        metrics.maxSlotLatenessMs = Math.max(
          metrics.maxSlotLatenessMs,
          started - Date.parse(job.due_at),
        );
        const result = await guard.check(job.url);
        results[index] = {
          attempt_id: job.attempt_id,
          monitor_id: job.monitor_id,
          config_rev: job.config_rev,
          started_at: new Date(started).toISOString(),
          redirect_count: result.redirectCount,
          ...("errorType" in result
            ? { error_type: result.errorType }
            : { status_code: result.statusCode, response_ms: result.responseMs }),
        };
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_CHECKS, claim.jobs.length) }, checkNext),
    );
    if (deadline.signal.aborted) return metrics;

    const body = JSON.stringify({ results });
    const expectedAttempts = new Set(claim.jobs.map((job) => job.attempt_id));
    const outcomes = new Map<string, CheckOutcome>();
    for (let attempt = 0; attempt < 2 && !deadline.signal.aborted; attempt++) {
      try {
        const ingest = parseIngestResponse(await post(INTERNAL_INGEST_PATH, body));
        const acknowledged = new Set(ingest.results.map((result) => result.attempt_id));
        if (
          ingest.results.length !== expectedAttempts.size ||
          acknowledged.size !== expectedAttempts.size ||
          [...acknowledged].some((id) => !expectedAttempts.has(id))
        ) {
          throw new Error("Ingest response does not match the submitted batch.");
        }
        for (const result of ingest.results) {
          const previous = outcomes.get(result.attempt_id);
          // A replay can report dropped for an attempt that already succeeded.
          if (previous === undefined || previous === "error" || result.outcome === "accepted")
            outcomes.set(result.attempt_id, result.outcome);
        }
        if (![...outcomes.values()].includes("error")) break;
      } catch {
        // Retry the same results with a fresh signed nonce. The server uses
        // the attempt ID to make already accepted results safe to replay.
      }
    }
    for (const outcome of outcomes.values()) {
      if (outcome === "accepted") metrics.accepted++;
      else if (outcome === "dropped") metrics.dropped++;
    }
    metrics.errors -= metrics.accepted + metrics.dropped;
    if (metrics.errors === 0) metrics.outcome = "completed";
    return metrics;
  } catch {
    return metrics;
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
