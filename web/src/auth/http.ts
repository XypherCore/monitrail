import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { awaitSignal } from "../../../shared/ssrf/io.ts";
import type { AuthConfig } from "./config.ts";
import { oauthSignInRateKey, type createAuthRateLimitStorage } from "./rate-limit.ts";
import { sanitizeNextPath } from "./redirect.ts";

export type OAuthContext = {
  inviteHash: string | null;
  nextPath: string;
  provider: "github" | "google";
  stateHash: string;
  expires: number;
};
type AuthBoundary = {
  config: AuthConfig;
  rawHandler(request: Request, context?: OAuthContext): Promise<Response>;
  limits: ReturnType<typeof createAuthRateLimitStorage>;
};
const inputLimit = 8192;
const stateLifetimeSeconds = 900; // Matches Auth.js state and PKCE cookies.

export function readCookies(headers: Headers): Record<string, string> {
  const cookies: Record<string, string> = Object.create(null);
  const source = headers.get("cookie") ?? "";
  if (source.length > inputLimit) return cookies;
  try {
    for (const pair of source.split(";")) {
      const equals = pair.indexOf("=");
      if (equals < 1) continue;
      const name = pair.slice(0, equals).trim();
      if (Object.hasOwn(cookies, name)) return Object.create(null);
      cookies[name] = decodeURIComponent(pair.slice(equals + 1).trim());
    }
  } catch {
    return Object.create(null);
  }
  return cookies;
}

function privateResponse(response: Response) {
  response.headers.set("cache-control", "no-store, max-age=0");
  response.headers.set("pragma", "no-cache");
  response.headers.set("vary", "Cookie");
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  return response;
}

function failure(status: number) {
  return privateResponse(
    Response.json(
      {
        error: {
          code: "AUTH_REQUEST_FAILED",
          message: "Authentication request failed. Try again.",
        },
      },
      { status },
    ),
  );
}

class InputFailure extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Invalid authentication request.");
    this.status = status;
  }
}

async function readObject(request: Request): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    throw new InputFailure(400);
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > inputLimit))
    throw new InputFailure(413);
  if (!request.body) throw new InputFailure(400);
  const reader = request.body.getReader();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10000);
  const bytes = new Uint8Array(inputLimit);
  let used = 0;
  try {
    for (;;) {
      const chunk = await awaitSignal(reader.read(), timeout.signal);
      if (chunk.done) break;
      if (chunk.value.byteLength > inputLimit - used) throw new InputFailure(413);
      bytes.set(chunk.value, used);
      used += chunk.value.byteLength;
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputFailure(400);
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof InputFailure) throw error;
    throw new InputFailure(timeout.signal.aborted ? 408 : 400);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* A canceled read may still be settling. */
    }
  }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const signature = (secret: string, value: string) =>
  createHmac("sha256", secret).update("monitrail:oauth-context:v1\0").update(value).digest();

function encodeContext(context: OAuthContext, secret: string) {
  const payload = Buffer.from(JSON.stringify(context)).toString("base64url");
  return `${payload}.${signature(secret, payload).toString("base64url")}`;
}

function decodeContext(value: string | undefined, secret: string): OAuthContext | null {
  if (!value || value.length > 2048) return null;
  const parts = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]{43})$/.exec(value);
  if (!parts) return null;
  try {
    if (!timingSafeEqual(signature(secret, parts[1]), Buffer.from(parts[2], "base64url")))
      return null;
    const context = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as OAuthContext;
    if (
      (context.provider !== "github" && context.provider !== "google") ||
      !/^[a-f0-9]{64}$/.test(context.stateHash) ||
      (context.inviteHash !== null && !/^[a-f0-9]{64}$/.test(context.inviteHash)) ||
      !Number.isSafeInteger(context.expires) ||
      context.expires <= Date.now() ||
      context.expires > Date.now() + stateLifetimeSeconds * 1000 ||
      sanitizeNextPath(context.nextPath) !== context.nextPath
    )
      return null;
    return context;
  } catch {
    return null;
  }
}

export function createAuthRequestHandler(auth: AuthBoundary, baseURL: string) {
  const secure = baseURL.startsWith("https:");
  const contextCookie = `${secure ? "__Secure-" : ""}monitrail.oauth-context`;
  const cookie = (value: string, lifetime: number) =>
    contextCookie +
    "=" +
    value +
    "; Path=/api/auth; HttpOnly; SameSite=Lax; Max-Age=" +
    lifetime +
    (secure ? "; Secure" : "");

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const callback = /^\/api\/auth\/callback\/(github|google)$/.exec(url.pathname);
    const signIn = url.pathname === "/api/auth/sign-in/social";
    const signOut = url.pathname === "/api/auth/sign-out";
    const session = url.pathname === "/api/auth/get-session";
    const csrf = url.pathname === "/api/auth/csrf";
    if (!callback && !signIn && !signOut && !session && !csrf) return failure(404);
    if (request.method !== (callback || session || csrf ? "GET" : "POST")) return failure(405);
    if ((signIn || signOut) && request.headers.get("origin") !== baseURL) return failure(403);

    try {
      if (csrf)
        return privateResponse(
          await auth.rawHandler(
            new Request(`${baseURL}/api/auth/csrf`, { headers: request.headers }),
          ),
        );
      if (session) {
        const raw = await auth.rawHandler(
          new Request(`${baseURL}/api/auth/session`, { headers: request.headers }),
        );
        if (!raw.ok) return failure(503);
        const body = (await raw.json()) as {
          user?: { id: string; name: string; email: string | null };
          expires?: string;
        };
        const current =
          body.user && body.expires
            ? {
                user: { id: body.user.id, name: body.user.name, email: body.user.email },
                session: { expiresAt: body.expires },
              }
            : null;
        return privateResponse(Response.json(current, { headers: raw.headers }));
      }
      if (callback) {
        const context = decodeContext(
          readCookies(request.headers)[contextCookie],
          auth.config.secret,
        );
        const state = url.searchParams.get("state");
        let response: Response;
        if (
          !context ||
          !state ||
          state.length > 512 ||
          context.provider !== callback[1] ||
          context.stateHash !== hash(state) ||
          !(await auth.limits.consumeOAuthState(context.stateHash))
        ) {
          response = new Response(null, {
            status: 302,
            headers: { location: `${baseURL}/login?error=oauth` },
          });
        } else {
          const raw = await auth.rawHandler(request, context);
          const destination = new URL(raw.headers.get("location") ?? "/login?error=oauth", baseURL);
          let location = `${baseURL}/login?error=oauth`;
          if (destination.origin === baseURL) {
            if (
              !destination.search &&
              !destination.hash &&
              sanitizeNextPath(destination.pathname) === destination.pathname
            ) {
              location = destination.href;
            } else if (
              destination.pathname === "/login" &&
              ["invite", "account_conflict", "oauth"].includes(
                destination.searchParams.get("error") ?? "",
              )
            ) {
              location =
                baseURL +
                "/login?error=" +
                destination.searchParams.get("error") +
                "&next=" +
                encodeURIComponent(context.nextPath);
            }
          }
          const headers = new Headers(raw.headers);
          headers.set("location", location);
          response = new Response(null, { status: 302, headers });
        }
        response.headers.append("set-cookie", cookie("", 0));
        return privateResponse(response);
      }

      const body = await readObject(request);
      if (typeof body.csrfToken !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(body.csrfToken))
        return failure(400);
      if (signOut) {
        if (Object.keys(body).some((key) => key !== "csrfToken")) return failure(400);
        const raw = await auth.rawHandler(
          new Request(`${baseURL}/api/auth/signout`, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify({ csrfToken: body.csrfToken, callbackUrl: baseURL, json: "true" }),
          }),
        );
        const result = (await raw.json()) as { url?: string };
        if (!raw.ok || (result.url !== baseURL && result.url !== `${baseURL}/`))
          return failure(403);
        return privateResponse(Response.json({ url: baseURL }, { headers: raw.headers }));
      }
      if (
        Object.keys(body).some(
          (key) => !["provider", "callbackURL", "csrfToken", "inviteCode"].includes(key),
        ) ||
        (body.provider !== "github" && body.provider !== "google") ||
        (body.inviteCode !== undefined &&
          (typeof body.inviteCode !== "string" || body.inviteCode.length > 256))
      )
        return failure(400);
      const nextPath = sanitizeNextPath(body.callbackURL);
      if (body.callbackURL !== undefined && body.callbackURL !== nextPath) return failure(400);
      const limit = await auth.limits.consume(oauthSignInRateKey(request.headers), {
        window: 10,
        max: 3,
      });
      if (!limit.allowed) {
        const response = failure(429);
        response.headers.set("retry-after", String(limit.retryAfter));
        return response;
      }
      const raw = await auth.rawHandler(
        new Request(`${baseURL}/api/auth/signin/${body.provider}`, {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify({
            csrfToken: body.csrfToken,
            callbackUrl: baseURL + nextPath,
            json: "true",
          }),
        }),
      );
      if (!raw.ok) return failure(503);
      const result = (await raw.json()) as { url?: string };
      const authorization = new URL(result.url ?? "", baseURL);
      const state = authorization.searchParams.get("state");
      const expectedHost = body.provider === "github" ? "github.com" : "accounts.google.com";
      if (authorization.protocol !== "https:" || authorization.hostname !== expectedHost || !state)
        return failure(400);
      const context: OAuthContext = {
        provider: body.provider,
        stateHash: hash(state),
        nextPath,
        inviteHash:
          typeof body.inviteCode === "string" && body.inviteCode.trim()
            ? hash(body.inviteCode.trim())
            : null,
        expires: Date.now() + stateLifetimeSeconds * 1000,
      };
      await auth.limits.reserveOAuthState(context.stateHash);
      const response = Response.json({ url: authorization.href }, { headers: raw.headers });
      response.headers.append(
        "set-cookie",
        cookie(encodeContext(context, auth.config.secret), stateLifetimeSeconds),
      );
      return privateResponse(response);
    } catch (error) {
      return failure(error instanceof InputFailure ? error.status : 503);
    }
  };
}
