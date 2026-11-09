import { checkerUserAgent } from "../identity.ts";
import { isRedirectStatus, parseRedirectTarget, parseTarget } from "./address.ts";
import { type BlockedHost, prepareBlocklist } from "./blocklist.ts";
import { awaitSignal, cancelBody, discardBody, type Transport } from "./io.ts";

export type WorkerCheckResult =
  | { statusCode: number; responseMs: number; redirectCount: number }
  | { errorType: "blocked" | "connect" | "timeout"; redirectCount: number };

export type WorkerGuardDependencies = {
  appUrl: string;
  blocklist: readonly BlockedHost[];
  fetch: Transport;
};

/**
 * Worker-only profile. DNS validation occurs in the web application and its
 * maintenance job. A Worker independently resolves target names and cannot
 * pin external targets to vetted IPs. Static checks cannot prevent a public
 * hostname or redirect hostname from resolving privately. Phase 5 must verify
 * the deployed egress boundary before release.
 */
export function createWorkerGuard(dependencies: WorkerGuardDependencies) {
  const blocked = prepareBlocklist(dependencies.blocklist);
  const userAgent = checkerUserAgent(dependencies.appUrl);
  const transport = dependencies.fetch;
  if (typeof transport !== "function") throw new Error("Invalid Worker transport.");

  return {
    async check(input: string): Promise<WorkerCheckResult> {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), 10000);
      let redirectCount = 0;
      let responseMs = 0;
      let url: URL;

      try {
        try {
          url = parseTarget(input);
        } catch {
          return { errorType: "blocked", redirectCount };
        }
        if (blocked(url.hostname)) return { errorType: "blocked", redirectCount };
        for (;;) {
          if (deadline.signal.aborted) return { errorType: "timeout", redirectCount };

          const request = new AbortController();
          const abort = () => request.abort();
          deadline.signal.addEventListener("abort", abort, { once: true });
          let response: Response | undefined;

          try {
            const startedAt = performance.now();
            const fetched = await awaitSignal<Response>(
              Promise.resolve().then(async () => {
                if (request.signal.aborted) throw new Error("Operation aborted.");
                const result = await transport(url.href, {
                  method: "GET",
                  redirect: "manual",
                  credentials: "omit",
                  cache: "no-store",
                  headers: { "User-Agent": userAgent },
                  signal: request.signal,
                });
                if (request.signal.aborted) cancelBody(result);
                return result;
              }),
              deadline.signal,
            );
            response = fetched;
            const elapsed = performance.now() - startedAt;
            if (
              !Number.isFinite(elapsed) ||
              elapsed < 0 ||
              fetched.redirected ||
              !Number.isInteger(fetched.status) ||
              fetched.status < 100 ||
              fetched.status > 599
            ) {
              return { errorType: "connect", redirectCount };
            }
            responseMs += elapsed;

            const location = isRedirectStatus(fetched.status)
              ? fetched.headers.get("location")
              : null;
            if (location !== null) {
              if (redirectCount === 2) return { errorType: "blocked", redirectCount };
              let next: URL;
              try {
                next = parseRedirectTarget(location, url);
                if (blocked(next.hostname)) return { errorType: "blocked", redirectCount };
              } catch {
                return { errorType: "blocked", redirectCount };
              }
              url = next;
              redirectCount++;
              continue;
            }

            const result = {
              statusCode: fetched.status,
              responseMs: Math.min(10000, Math.round(responseMs)),
              redirectCount,
            };
            try {
              await discardBody(fetched, deadline.signal);
            } catch {
              // The server judges the received headers. Body cleanup must
              // never turn an already measured response into a failed check.
            }
            return result;
          } catch {
            return { errorType: deadline.signal.aborted ? "timeout" : "connect", redirectCount };
          } finally {
            if (response) cancelBody(response);
            deadline.signal.removeEventListener("abort", abort);
            request.abort();
          }
        }
      } finally {
        clearTimeout(timer);
        deadline.abort();
      }
    },
  };
}
