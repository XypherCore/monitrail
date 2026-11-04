import { hasForbiddenUrlCharacters, isPublicAddress, parseTarget } from "./address.ts";
import { awaitSignal, cancelBody, discardBody, type Transport } from "./io.ts";

export type GuardCode = "blocked" | "dns" | "timeout" | "connect";
const messages: Record<GuardCode, string> = {
  blocked: "This address is not allowed for monitoring.",
  dns: "The address could not be safely resolved.",
  timeout: "The monitoring request timed out.",
  connect: "The monitoring connection failed.",
};
export class SsrfError extends Error {
  readonly code: GuardCode;
  constructor(code: GuardCode) {
    super(messages[code]);
    this.name = "SsrfError";
    this.code = code;
  }
}

export type GuardDependencies = {
  resolve(host: string, options: { signal: AbortSignal }): Promise<readonly string[]>;
  isBlockedHost(host: string, options: { signal: AbortSignal }): Promise<boolean>;
  fetch: Transport;
  userAgent: string;
};

function isLiteral(host: string): boolean {
  return host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}
function policy(input: string): URL {
  try {
    return parseTarget(input);
  } catch {
    throw new SsrfError("blocked");
  }
}
function redirected(location: string | null, current: URL): URL {
  if (!location || hasForbiddenUrlCharacters(location)) throw new SsrfError("blocked");
  // Preserve original authority syntax so URL parsing cannot erase empty userinfo.
  if (/^[a-z][a-z\d+.-]*:/i.test(location)) return policy(location);
  if (location.startsWith("//")) return policy(`${current.protocol}${location}`);
  try {
    return policy(new URL(location, current).href);
  } catch {
    throw new SsrfError("blocked");
  }
}

/**
 * The only target-fetch boundary. No caller headers, body, cookies or credentials
 * are accepted, and no response/body/header object escapes it.
 *
 * Workers cannot pin arbitrary targets to DoH-vetted IPs. Strict revalidation
 * reduces exposure but does not eliminate the DNS-rebinding race between DoH
 * and fetch's independent resolution; do not claim complete rebinding protection.
 */
export function createSsrfGuard(dependencies: GuardDependencies) {
  const { resolve, isBlockedHost, fetch: transport, userAgent } = dependencies;
  if (
    typeof resolve !== "function" ||
    typeof isBlockedHost !== "function" ||
    typeof transport !== "function" ||
    typeof userAgent !== "string" ||
    !userAgent ||
    /[\r\n]/.test(userAgent)
  )
    throw new SsrfError("blocked");
  try {
    const identity = /^Monitrail\/1\.0 \(\+(https?:\/\/[^/?#@]+\/bot)\)$/.exec(userAgent)?.[1];
    if (!identity || hasForbiddenUrlCharacters(identity) || new URL(identity).pathname !== "/bot")
      throw new Error();
  } catch {
    throw new SsrfError("blocked");
  }

  async function operation<T>(
    action: (
      signal: AbortSignal,
      stage: <R>(task: () => Promise<R>, code: GuardCode) => Promise<R>,
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    async function stage<R>(task: () => Promise<R>, code: GuardCode): Promise<R> {
      try {
        return await awaitSignal(
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error("Operation aborted.");
            return task();
          }),
          controller.signal,
        );
      } catch {
        throw new SsrfError(timedOut ? "timeout" : code);
      }
    }
    try {
      return await action(controller.signal, stage);
    } catch (error) {
      if (timedOut) throw new SsrfError("timeout");
      if (error instanceof SsrfError) throw error;
      throw new SsrfError("blocked");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function vetted(
    url: URL,
    signal: AbortSignal,
    stage: <R>(task: () => Promise<R>, code: GuardCode) => Promise<R>,
  ): Promise<void> {
    const blocked = await stage(() => isBlockedHost(url.hostname, { signal }), "blocked");
    if (typeof blocked !== "boolean" || blocked) throw new SsrfError("blocked");
    if (isLiteral(url.hostname)) {
      if (!isPublicAddress(url.hostname)) throw new SsrfError("blocked");
      return;
    }
    const addresses = await stage(() => resolve(url.hostname, { signal }), "dns");
    if (
      !Array.isArray(addresses) ||
      addresses.length === 0 ||
      addresses.some((address) => typeof address !== "string" || !address)
    )
      throw new SsrfError("dns");
    if (addresses.some((address) => !isPublicAddress(address))) throw new SsrfError("blocked");
  }

  return {
    async validate(input: string): Promise<{ url: string }> {
      return operation(async (signal, stage) => {
        const url = policy(input);
        await vetted(url, signal, stage);
        return { url: url.href };
      });
    },
    async check(input: string): Promise<{ statusCode: number }> {
      return operation(async (signal, stage) => {
        let url = policy(input);
        for (let hops = 0; hops <= 3; hops++) {
          await vetted(url, signal, stage);
          const request = new AbortController();
          const abort = () => request.abort();
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
          let response: Response | undefined;
          try {
            const fetched = await stage(async () => {
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
            }, "connect");
            response = fetched;
            if (
              fetched.redirected ||
              !Number.isInteger(fetched.status) ||
              fetched.status < 100 ||
              fetched.status > 599
            )
              throw new SsrfError("connect");
            if ([301, 302, 303, 307, 308].includes(fetched.status)) {
              if (hops === 3) throw new SsrfError("blocked");
              url = redirected(fetched.headers.get("location"), url);
            } else {
              await stage(() => discardBody(fetched, signal), "connect");
              return { statusCode: fetched.status };
            }
          } finally {
            if (response) cancelBody(response);
            signal.removeEventListener("abort", abort);
            request.abort();
          }
        }
        throw new SsrfError("blocked");
      });
    },
  };
}
