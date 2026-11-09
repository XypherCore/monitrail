import { timingSafeEqual } from "node:crypto";
import {
  parseClaimRequest,
  parseIngestRequest,
  type ClaimResponse,
  type IngestResponse,
} from "../../../shared/checks/protocol.ts";
import {
  computeInternalSignature,
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_CLAIM_PATH,
  INTERNAL_CLOCK_SKEW_SECONDS,
  INTERNAL_INGEST_PATH,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  isInternalSecret,
  isInternalUuid,
  type InternalPath,
} from "../../../shared/checks/signing.ts";
import { awaitSignal } from "../../../shared/ssrf/io.ts";
import type { CheckCapabilities } from "./capabilities.ts";

type Dependencies = {
  secret(): unknown;
  checks(): CheckCapabilities;
  consumeNonce(nonce: string): Promise<boolean>;
  now?(): Date;
};
type SignedHeaders = { nonce: string; timestamp: string; seconds: number; signature: string };
type Operation = (body: Uint8Array<ArrayBuffer>) => Promise<ClaimResponse | IngestResponse>;

const privateHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const uploadTimeoutMs = 10000;

class RequestBodyError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Invalid internal request body.");
    this.status = status;
  }
}

function fail(status: number) {
  return Response.json({ error: "Internal request could not be completed." }, {
    status,
    headers: privateHeaders,
  });
}

function readSignedHeaders(headers: Headers): SignedHeaders | null {
  const nonce = headers.get(INTERNAL_NONCE_HEADER);
  const timestamp = headers.get(INTERNAL_TIMESTAMP_HEADER);
  const signature = headers.get(INTERNAL_SIGNATURE_HEADER);
  if (
    !isInternalUuid(nonce) ||
    !timestamp || !/^(?:0|[1-9]\d{0,15})$/.test(timestamp) ||
    !signature || !/^[0-9a-f]{64}$/.test(signature)
  ) return null;
  const seconds = Number(timestamp);
  return Number.isSafeInteger(seconds) ? { nonce, timestamp, seconds, signature } : null;
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const contentType = request.headers.get("content-type") ?? "";
  const encoding = request.headers.get("content-encoding") ?? "identity";
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(contentType) ||
    encoding.toLowerCase() !== "identity"
  ) throw new RequestBodyError(415);
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declared)) throw new RequestBodyError(400);
    if (Number(declared) > INTERNAL_BODY_LIMIT_BYTES) throw new RequestBodyError(413);
  }
  if (!request.body) {
    if (declared !== null && Number(declared) !== 0) throw new RequestBodyError(400);
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), uploadTimeoutMs);
  const signal = AbortSignal.any([controller.signal, request.signal]);
  try {
    const bytes = new Uint8Array(INTERNAL_BODY_LIMIT_BYTES);
    let used = 0;
    for (;;) {
      const chunk = await awaitSignal(reader.read(), signal);
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.length - used) throw new RequestBodyError(413);
      bytes.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    if (declared !== null && Number(declared) !== used) throw new RequestBodyError(400);
    return bytes.subarray(0, used);
  } catch (error) {
    if (error instanceof RequestBodyError) throw error;
    throw new RequestBodyError(controller.signal.aborted ? 408 : 400);
  } finally {
    clearTimeout(timer);
    // A client can stall stream cancellation. Do not await it.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseBody<T>(body: Uint8Array<ArrayBuffer>, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    throw new RequestBodyError(400);
  }
}

export function createInternalHandlers(dependencies: Dependencies) {
  const now = dependencies.now ?? (() => new Date());
  const current = (seconds: number) => {
    const instant = now().getTime() / 1000;
    return Number.isFinite(instant) && Math.abs(instant - seconds) <= INTERNAL_CLOCK_SKEW_SECONDS;
  };

  async function handle(request: Request, path: InternalPath, operation: Operation): Promise<Response> {
    if (request.method !== "POST") {
      const response = fail(405);
      response.headers.set("allow", "POST");
      return response;
    }

    try {
      const url = new URL(request.url);
      const signed = readSignedHeaders(request.headers);
      if (url.pathname !== path || url.search || url.hash || !signed || !current(signed.seconds)) {
        return fail(401);
      }
      const secret = dependencies.secret();
      if (!isInternalSecret(secret)) return fail(503);
      const body = await readBody(request);
      if (!current(signed.seconds)) return fail(401);
      const digest = await computeInternalSignature(secret, path, signed.timestamp, signed.nonce, body);
      if (!timingSafeEqual(Buffer.from(digest), Buffer.from(signed.signature, "hex"))) return fail(401);
      if (!(await dependencies.consumeNonce(signed.nonce))) return fail(401);
      return Response.json(await operation(body), { headers: privateHeaders });
    } catch (error) {
      return fail(error instanceof RequestBodyError ? error.status : 503);
    }
  }

  return {
    claim(request: Request) {
      return handle(request, INTERNAL_CLAIM_PATH, async (body) => {
        const input = parseBody(body, parseClaimRequest);
        const { jobs, blocklist } = await dependencies.checks().claimChecks(input);
        return {
          jobs: jobs.map((job) => ({
            attempt_id: job.attemptId,
            monitor_id: job.monitorId,
            config_rev: job.configRev,
            url: job.url,
            expected_status: job.expectedStatus,
            due_at: job.dueAt.toISOString(),
          })),
          blocklist: blocklist.map((entry) => ({
            host: entry.host,
            include_subdomains: entry.includeSubdomains,
          })),
        };
      });
    },
    ingest(request: Request) {
      return handle(request, INTERNAL_INGEST_PATH, async (body) => {
        const { results } = parseBody(body, parseIngestRequest);
        const outcomes = await dependencies.checks().ingestResults({
          results: results.map((result) => ({
            attemptId: result.attempt_id,
            monitorId: result.monitor_id,
            configRev: result.config_rev,
            startedAt: new Date(result.started_at),
            redirectCount: result.redirect_count,
            ...("error_type" in result
              ? { errorType: result.error_type }
              : { statusCode: result.status_code, responseMs: result.response_ms }),
          })),
        });
        return { results: outcomes.map((outcome) => ({ attempt_id: outcome.attemptId, outcome: outcome.outcome })) };
      });
    },
  };
}
