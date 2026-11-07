import { randomUUID } from "node:crypto";
import NextAuthModule, { type NextAuthOptions } from "next-auth";
import GitHubModule from "next-auth/providers/github";
import GoogleModule from "next-auth/providers/google";
import type { AuthConfig } from "./config.ts";
import { createAuthRequestHandler, readCookies, type OAuthContext } from "./http.ts";
import { createAuthPersistence, AuthPersistenceError, type AuthDatabase } from "./persistence.ts";
import { createAuthRateLimitStorage } from "./rate-limit.ts";
import { sanitizeNextPath } from "./redirect.ts";

// NextAuth v4's public CJS exports have a default wrapper under native ESM.
function callable<T>(module: T): T {
  return (typeof module === "function" ? module : (module as { default: T }).default) as T;
}
const NextAuth = callable(NextAuthModule);
const GitHub = callable(GitHubModule);
const Google = callable(GoogleModule);

type ApiRequest = {
  method: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  body?: unknown;
};
type ApiResponse = {
  status(code: number): ApiResponse;
  getHeader(name: string): string | string[] | undefined;
  setHeader(name: string, value: string | string[]): ApiResponse;
  end(): void;
  json(body: unknown): void;
  send(body: unknown): void;
};
const invoke = NextAuth as unknown as (
  request: ApiRequest,
  response: ApiResponse,
  options: NextAuthOptions,
) => Promise<void>;

export function createAuthCore(db: AuthDatabase, config: AuthConfig) {
  if (process.env.NEXTAUTH_URL && process.env.NEXTAUTH_URL !== `${config.baseURL}/api/auth`) {
    throw new Error("Authentication configuration is invalid.");
  }
  process.env.NEXTAUTH_URL = `${config.baseURL}/api/auth`;
  const persistence = createAuthPersistence(db);
  const limits = createAuthRateLimitStorage(db, config.secret);
  const secure = config.baseURL.startsWith("https:");
  const sessionCookieName = `${secure ? "__Secure-" : ""}next-auth.session-token`;
  const options: NextAuthOptions = {
    secret: config.secret,
    adapter: persistence.adapter,
    providers: [
      {
        ...GitHub({ ...config.github, checks: ["state", "pkce"] }),
        userinfo: {
          url: "https://api.github.com/user",
          async request({ client, tokens }) {
            const accessToken = tokens.access_token;
            if (!accessToken) throw new Error("Missing GitHub access token.");
            const profile = await client.userinfo(accessToken);
            if (profile.email) return profile;

            // Auth.js v4 dereferences the first result even when GitHub returns an empty list.
            const response = await fetch("https://api.github.com/user/emails", {
              headers: { authorization: `Bearer ${accessToken}` },
              redirect: "error",
            });
            if (!response.ok) return profile;
            const emails: unknown = await response.json();
            if (!Array.isArray(emails)) return profile;
            const address = (emails.find((entry) => entry?.primary === true) ?? emails[0])?.email;
            return typeof address === "string" ? { ...profile, email: address } : profile;
          },
        },
      },
      Google({ ...config.google, checks: ["state", "pkce"] }),
    ],
    session: { strategy: "database", generateSessionToken: randomUUID },
    useSecureCookies: secure,
    pages: { signIn: `${config.baseURL}/login`, error: `${config.baseURL}/login` },
    debug: false,
    logger: { error() {}, warn() {}, debug() {} },
    callbacks: {
      async redirect({ url }) {
        const target = new URL(url, config.baseURL);
        if (target.origin !== config.baseURL || target.search || target.hash)
          return `${config.baseURL}/dashboard`;
        return config.baseURL + (target.pathname === "/" ? "" : sanitizeNextPath(target.pathname));
      },
      async session({ session, user }) {
        return {
          expires: session.expires,
          user: { id: user.id, name: user.name, email: user.email },
        };
      },
    },
  };

  async function getSession(headers: Headers) {
    const token = readCookies(headers)[sessionCookieName];
    if (!token) return null;
    const found = await persistence.getSessionAndUser(token);
    return found
      ? {
          user: { id: found.user.id, name: found.user.name, email: found.user.email },
          session: { expiresAt: found.session.expires },
        }
      : null;
  }

  async function rawHandler(request: Request, context?: OAuthContext): Promise<Response> {
    const requestUrl = new URL(request.url);
    const nextauth = requestUrl.pathname.slice("/api/auth/".length).split("/");
    const parsed =
      request.method === "POST" ? ((await request.json()) as Record<string, unknown>) : undefined;
    let status = 200;
    let body: unknown;
    let sessionUnavailable = false;
    const output = new Headers();
    const outputArrays = new Map<string, string[]>();
    const response: ApiResponse = {
      status(code) {
        status = code;
        return response;
      },
      getHeader(name) {
        return outputArrays.get(name.toLowerCase()) ?? output.get(name) ?? undefined;
      },
      setHeader(name, value) {
        output.delete(name);
        if (Array.isArray(value)) {
          outputArrays.set(name.toLowerCase(), value);
          for (const item of value) output.append(name, item);
        } else {
          outputArrays.delete(name.toLowerCase());
          output.set(name, value);
        }
        return response;
      },
      end() {},
      json(value) {
        body = value;
        output.set("content-type", "application/json");
      },
      send(value) {
        body = value;
      },
    };
    await invoke(
      {
        method: request.method,
        query: { ...Object.fromEntries(requestUrl.searchParams), nextauth },
        headers: {
          ...Object.fromEntries(request.headers),
          host: new URL(config.baseURL).host,
          "x-forwarded-host": new URL(config.baseURL).host,
          "x-forwarded-proto": secure ? "https" : "http",
        },
        cookies: readCookies(request.headers),
        body: parsed,
      },
      response,
      {
        ...options,
        logger: {
          error(code) {
            if (code === "SESSION_ERROR") sessionUnavailable = true;
          },
          warn() {},
          debug() {},
        },
        callbacks: {
          ...options.callbacks,
          async signIn({ user, account }) {
            if (
              !context ||
              !account ||
              (account.provider !== "github" && account.provider !== "google")
            )
              return false;
            try {
              const existing = await persistence.getUserByAccount(account);
              const session = await getSession(request.headers);
              if (session && (!existing || existing.id !== session.user.id)) {
                throw new AuthPersistenceError("account-conflict");
              }
              await persistence.provision(
                {
                  provider: account.provider,
                  providerAccountId: account.providerAccountId,
                  name: user.name || "Account",
                  email: user.email || null,
                  image: user.image || null,
                },
                context.inviteHash,
                config.signupMode,
              );
              return true;
            } catch (error) {
              const category =
                error instanceof AuthPersistenceError ? error.category : "unavailable";
              const code =
                category === "account-conflict"
                  ? "account_conflict"
                  : category === "invite"
                    ? "invite"
                    : "oauth";
              return `${config.baseURL}/login?error=${code}&next=${encodeURIComponent(context.nextPath)}`;
            }
          },
        },
      },
    );
    if (sessionUnavailable) throw new Error("Authentication is temporarily unavailable.");
    if (body === undefined || body === null) return new Response(null, { status, headers: output });
    if (typeof body === "object") return Response.json(body, { status, headers: output });
    return new Response(String(body), { status, headers: output });
  }

  const auth = {
    rawHandler,
    limits,
    config,
    api: {
      getSession: ({ headers }: { headers: Headers; query?: { disableRefresh?: boolean } }) =>
        getSession(headers),
    },
  };
  return { ...auth, options, handler: createAuthRequestHandler(auth, config.baseURL) };
}
