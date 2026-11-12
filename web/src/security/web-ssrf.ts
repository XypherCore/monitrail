import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { ClientRequest, IncomingMessage } from "node:http";
import { Agent, request as httpsRequest, type RequestOptions } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { checkServerIdentity } from "node:tls";
import { checkerUserAgent } from "../../../shared/identity.ts";
import {
  canonicalPolicyHost,
  isPublicAddress,
  parseTarget,
  parseWebhookTarget,
  type WebhookProvider,
} from "../../../shared/ssrf/address.ts";
import { awaitSignal } from "../../../shared/ssrf/io.ts";
import { isTelegramBotToken, isTelegramChatId } from "../alerts/telegram-target.ts";

type ErrorCode = "blocked" | "dns" | "timeout" | "connect" | "tls" | "bad_status" | "other";
const messages: Record<ErrorCode, string> = {
  blocked: "This address is not allowed.",
  dns: "The address could not be safely resolved.",
  timeout: "The request timed out.",
  connect: "The connection failed.",
  tls: "The secure connection failed.",
  bad_status: "The recipient returned an unsuccessful status.",
  other: "The request could not be completed.",
};

export class WebGuardError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(messages[code]);
    this.name = "WebGuardError";
    this.code = code;
  }
}

type Options = {
  appUrl: string;
  isBlockedHost(host: string, options: { signal: AbortSignal }): Promise<boolean>;
};
type Dependencies = {
  resolve(host: string, options: { signal: AbortSignal }): Promise<readonly LookupAddress[]>;
  request(options: RequestOptions, listener: (response: IncomingMessage) => void): ClientRequest;
};
type PinnedRequestOptions = RequestOptions & { autoSelectFamily: false };

const tlsErrors = new Set([
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_REVOKED",
  "EPROTO",
]);

function connectionError(error: unknown): WebGuardError {
  if (error instanceof WebGuardError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return new WebGuardError(typeof code === "string" && tlsErrors.has(code) ? "tls" : "connect");
}

function hostname(url: URL): string {
  return url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
}

function blocked(): never {
  throw new WebGuardError("blocked");
}

function webhookTarget(input: string, provider: WebhookProvider): URL {
  try {
    return parseWebhookTarget(input, provider);
  } catch {
    blocked();
  }
}

function serializePayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error();
    return serialized;
  } catch {
    throw new WebGuardError("other");
  }
}

// The fixed Telegram API has an application-level success field. Only this
// trusted provider's bounded reply is read, and the result stays a boolean.
async function telegramSucceeded(response: IncomingMessage): Promise<boolean> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const data of response) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    bytes += chunk.length;
    if (bytes > 65_536) return false;
    chunks.push(chunk);
  }
  const reply: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
  return typeof reply === "object" && reply !== null && "ok" in reply && reply.ok === true;
}

/**
 * Server-only transport. The optional dependencies are trusted test adapters,
 * never request input. No caller headers, proxy, agent or TLS options are accepted.
 */
export function createWebGuard(options: Options, dependencies: Partial<Dependencies> = {}) {
  const userAgent = checkerUserAgent(options.appUrl);
  if (typeof options.isBlockedHost !== "function") blocked();
  const resolve =
    dependencies.resolve ??
    (async (host: string) => lookup(host, { all: true, family: 0, hints: 0, verbatim: true }));
  const request = dependencies.request ?? httpsRequest;

  async function budget<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      return await awaitSignal(
        Promise.resolve().then(() => action(controller.signal)),
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted) throw new WebGuardError("timeout");
      if (error instanceof WebGuardError) throw error;
      throw new WebGuardError("other");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function hostAllowed(url: URL, signal: AbortSignal): Promise<string> {
    const host = canonicalPolicyHost(url.hostname);
    if (!host || signal.aborted) blocked();
    let decision: boolean;
    try {
      decision = await awaitSignal(options.isBlockedHost(host, { signal }), signal);
    } catch {
      blocked();
    }
    if (decision !== false) blocked();
    return host;
  }

  async function addresses(host: string, signal: AbortSignal): Promise<LookupAddress[]> {
    if (signal.aborted) throw new WebGuardError("timeout");
    const literal = isIP(host);
    let answer: readonly LookupAddress[];
    try {
      answer = literal
        ? [{ address: host, family: literal }]
        : await awaitSignal(resolve(host, { signal }), signal);
    } catch {
      throw new WebGuardError("dns");
    }
    if (signal.aborted) throw new WebGuardError("timeout");
    if (!Array.isArray(answer) || answer.length === 0) throw new WebGuardError("dns");
    return answer.map((item) => {
      if (
        !item ||
        typeof item.address !== "string" ||
        ![4, 6].includes(item.family) ||
        isIP(item.address) !== item.family
      ) {
        throw new WebGuardError("dns");
      }
      if (!isPublicAddress(item.address)) blocked();
      return { address: item.address, family: item.family };
    });
  }

  function dialLookup(host: string, signal: AbortSignal): LookupFunction {
    return (requested, lookupOptions, callback) => {
      let called = false;
      const complete: typeof callback = (error, address, family) => {
        if (called) return;
        called = true;
        callback(error, address, family);
      };
      if (requested !== host) {
        complete(new WebGuardError("blocked"), "");
        return;
      }
      void addresses(host, signal)
        .then((result) => {
          if (signal.aborted) throw new WebGuardError("timeout");
          const selected = result.find(
            (item) => !lookupOptions.family || item.family === lookupOptions.family,
          );
          if (!selected) throw new WebGuardError("dns");
          if (lookupOptions.all) complete(null, [selected]);
          else complete(null, selected.address, selected.family);
        })
        .catch((error) => {
          complete(error instanceof WebGuardError ? error : new WebGuardError("dns"), "");
        });
    };
  }

  async function post(
    url: URL,
    data: string,
    signal: AbortSignal,
    confirmTelegram = false,
  ): Promise<{ statusCode: number }> {
    const host = hostname(url);
    const lookupAtConnect = dialLookup(host, signal);
    // A fresh, explicit agent prevents socket/session reuse and ignores global
    // HTTP(S)_PROXY/NODE_USE_ENV_PROXY settings. Node never re-resolves a vetted IP.
    const agent = new Agent({
      keepAlive: false,
      maxSockets: 1,
      maxTotalSockets: 1,
      maxCachedSessions: 0,
      proxyEnv: undefined,
      lookup: lookupAtConnect,
    });
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    try {
      if (signal.aborted) throw new WebGuardError("timeout");
      const pending = new Promise<{ statusCode: number }>((resolveResult, rejectResult) => {
        try {
          const requestOptions: PinnedRequestOptions = {
            protocol: "https:",
            hostname: host,
            port: 443,
            path: url.pathname + url.search,
            method: "POST",
            agent,
            lookup: lookupAtConnect,
            autoSelectFamily: false,
            servername: isIP(host) ? "" : host,
            rejectUnauthorized: true,
            checkServerIdentity: (_servername, certificate) =>
              checkServerIdentity(host, certificate),
            headers: {
              Host: url.host,
              "User-Agent": userAgent,
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
              Connection: "close",
            },
            signal,
          };
          outgoing = request(requestOptions, (response) => {
            incoming = response;
            // Neither response headers nor body data is exposed or persisted.
            response.on("error", () => {});
            const statusCode = response.statusCode;
            if (signal.aborted || !confirmTelegram) {
              try {
                response.destroy();
              } catch {
                /* Cleanup cannot replace the received status. */
              }
            }
            if (signal.aborted) return;
            if (
              !Number.isInteger(statusCode) ||
              statusCode === undefined ||
              statusCode < 200 ||
              statusCode > 299
            ) {
              rejectResult(new WebGuardError("bad_status"));
            } else if (confirmTelegram) {
              void telegramSucceeded(response).then(
                (ok) => {
                  if (ok) resolveResult({ statusCode });
                  else rejectResult(new WebGuardError("bad_status"));
                },
                () => rejectResult(new WebGuardError("bad_status")),
              );
            } else resolveResult({ statusCode });
          });
          outgoing.on("error", (error) => rejectResult(connectionError(error)));
          outgoing.on("upgrade", (_response, socket) => {
            socket.destroy();
            rejectResult(new WebGuardError("bad_status"));
          });
          outgoing.end(data);
        } catch (error) {
          rejectResult(connectionError(error));
        }
      });
      return await awaitSignal(pending, signal);
    } finally {
      try {
        incoming?.destroy();
      } catch {
        /* Cancellation is best effort. */
      }
      try {
        outgoing?.destroy();
      } catch {
        /* The request may already be closed. */
      }
      agent.destroy();
    }
  }

  return {
    validateMonitor(input: string): Promise<{ url: string; host: string }> {
      return budget(async (signal) => {
        let url: URL;
        try {
          url = parseTarget(input);
        } catch {
          blocked();
        }
        const host = await hostAllowed(url, signal);
        await addresses(hostname(url), signal);
        return { url: url.href, host };
      });
    },
    validateWebhook(
      input: string,
      provider: WebhookProvider,
    ): Promise<{ url: string; host: string }> {
      return budget(async (signal) => {
        const url = webhookTarget(input, provider);
        const host = await hostAllowed(url, signal);
        await addresses(hostname(url), signal);
        return { url: url.href, host };
      });
    },
    sendWebhook(
      input: string,
      provider: WebhookProvider,
      payload: unknown,
    ): Promise<{ statusCode: number }> {
      return budget(async (signal) => {
        const url = webhookTarget(input, provider);
        await hostAllowed(url, signal);
        if (provider === "discord") url.searchParams.set("wait", "true");
        return post(url, serializePayload(payload), signal);
      });
    },
    sendTelegram(botToken: string, chatId: string, text: string): Promise<{ statusCode: number }> {
      return budget(async (signal) => {
        if (!isTelegramBotToken(botToken) || !isTelegramChatId(chatId)) blocked();
        const url = new URL(`https://api.telegram.org/bot${botToken}/sendMessage`);
        await hostAllowed(url, signal);
        return post(url, serializePayload({
          chat_id: chatId,
          text,
          link_preview_options: { is_disabled: true },
        }), signal, true);
      });
    },
  };
}
