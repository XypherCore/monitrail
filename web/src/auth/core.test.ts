import { createHash, createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthCore } from "./core.ts";
import type { AuthConfig } from "./config.ts";

const origin = "https://app.example.invalid";
const inviteCode = "synthetic-invitation-for-tests";
const inviteHash = createHash("sha256").update(inviteCode).digest("hex");
const config: AuthConfig = {
  baseURL: origin,
  secret: "synthetic-auth-secret-for-isolated-tests-only",
  signupMode: "invite",
  github: { clientId: "fixture-github", clientSecret: "fixture-github-secret" },
  google: { clientId: "fixture-google", clientSecret: "fixture-google-secret" },
};

function cookieJar(...responses: Response[]): string {
  const jar = new Map<string, string>();
  for (const response of responses) {
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0];
      const name = pair.slice(0, pair.indexOf("="));
      if (pair.endsWith("=")) jar.delete(name);
      else jar.set(name, pair);
    }
  }
  return [...jar.values()].join("; ");
}

describe("stable Auth.js OAuth and database sessions", () => {
  let client: PGlite;
  let server: Server;
  let issuer: string;
  let auth: ReturnType<typeof createAuthCore>;
  let email: string | null = "oauth@example.invalid";
  let profileId = "42";
  let invalidSignature = false;
  let tokenRequests = 0;
  const challenges = new Map<string, string>();
  const codes = new Set<string>();
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  beforeAll(async () => {
    client = new PGlite();
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
    });
    server = createServer(async (request, response) => {
      try {
        response.setHeader("content-type", "application/json");
        const path = new URL(request.url ?? "/", issuer).pathname;
        if (path === "/.well-known/openid-configuration") {
          response.end(
            JSON.stringify({
              issuer,
              authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
              token_endpoint: `${issuer}/google/token`,
              jwks_uri: `${issuer}/jwks`,
              response_types_supported: ["code"],
              subject_types_supported: ["public"],
              id_token_signing_alg_values_supported: ["RS256"],
              token_endpoint_auth_methods_supported: ["client_secret_basic"],
            }),
          );
          return;
        }
        if (path === "/jwks") {
          response.end(
            JSON.stringify({
              keys: [
                {
                  ...publicKey.export({ format: "jwk" }),
                  kid: "fixture-key",
                  alg: "RS256",
                  use: "sig",
                },
              ],
            }),
          );
          return;
        }
        if (path.endsWith("/token")) {
          tokenRequests++;
          let raw = "";
          for await (const chunk of request) raw += chunk.toString();
          const params = new URLSearchParams(raw);
          const provider = path.startsWith("/google/") ? "google" : "github";
          const code = params.get("code") ?? "";
          const verifier = params.get("code_verifier") ?? "";
          if (
            !code ||
            codes.has(code) ||
            createHash("sha256").update(verifier).digest("base64url") !== challenges.get(provider)
          ) {
            response.writeHead(400);
            response.end(JSON.stringify({ error: "invalid_grant" }));
            return;
          }
          codes.add(code);
          const tokens: Record<string, unknown> = {
            access_token: "synthetic-provider-access-token",
            refresh_token: "synthetic-provider-refresh-token",
            expires_in: 3600,
            token_type: "Bearer",
          };
          if (provider === "google") {
            const now = Math.floor(Date.now() / 1000);
            const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString(
              "base64url",
            );
            const payload = Buffer.from(
              JSON.stringify({
                iss: issuer,
                aud: config.google.clientId,
                sub: profileId,
                name: "Fixture Google",
                email,
                iat: now,
                exp: now + 3600,
              }),
            ).toString("base64url");
            const unsigned = `${head}.${payload}`;
            const signed = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
            tokens.id_token = `${unsigned}.${invalidSignature ? `${signed.slice(0, -10)}invalidxxx` : signed}`;
          }
          response.end(JSON.stringify(tokens));
          return;
        }
        if (path === "/github/user") {
          response.end(
            JSON.stringify({ id: profileId, name: "Fixture GitHub", email, image: null }),
          );
          return;
        }
        response.writeHead(404);
        response.end("{}");
      } catch {
        response.writeHead(500);
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture server unavailable.");
    issuer = `http://127.0.0.1:${address.port}`;
  }, 30000);

  beforeEach(async () => {
    vi.stubEnv("NEXTAUTH_URL", `${origin}/api/auth`);
    await client.exec("TRUNCATE users,invites,rate_limits CASCADE");
    await client.query("INSERT INTO invites(code_hash) VALUES ($1)", [inviteHash]);
    auth = createAuthCore(drizzle(client), config);
    const github = auth.options.providers[0];
    if (github.type !== "oauth" || typeof github.userinfo !== "object" || !github.userinfo.request)
      throw new Error("Missing GitHub OAuth userinfo hook.");
    auth.options.providers = [
      {
        id: "github",
        name: "GitHub fixture",
        type: "oauth",
        issuer,
        authorization: "https://github.com/login/oauth/authorize",
        token: `${issuer}/github/token`,
        userinfo: { ...github.userinfo, url: `${issuer}/github/user` },
        checks: ["state", "pkce"],
        ...config.github,
        profile: (profile) => ({
          id: profile.id,
          name: profile.name,
          email: profile.email,
          image: null,
        }),
      },
      {
        id: "google",
        name: "Google fixture",
        type: "oauth",
        wellKnown: `${issuer}/.well-known/openid-configuration`,
        idToken: true,
        checks: ["state", "pkce"],
        ...config.google,
        profile: (profile) => ({
          id: profile.sub,
          name: profile.name,
          email: profile.email,
          image: null,
        }),
      },
    ];
    email = "oauth@example.invalid";
    profileId = "42";
    invalidSignature = false;
    tokenRequests = 0;
    challenges.clear();
    codes.clear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
  });

  async function begin(provider = "github", invitation: string | undefined = inviteCode) {
    const csrf = await auth.handler(new Request(`${origin}/api/auth/csrf`));
    const token = (await csrf.json()).csrfToken;
    const response = await auth.handler(
      new Request(`${origin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: { origin, cookie: cookieJar(csrf), "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          callbackURL: "/dashboard",
          csrfToken: token,
          inviteCode: invitation,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const authorization = new URL((await response.json()).url);
    const state = authorization.searchParams.get("state") ?? "";
    challenges.set(provider, authorization.searchParams.get("code_challenge") ?? "");
    return { state, authorization, response, cookie: cookieJar(csrf, response) };
  }

  async function finish(
    started: Awaited<ReturnType<typeof begin>>,
    provider = "github",
    extraCookie = "",
  ) {
    return auth.handler(
      new Request(
        origin +
          "/api/auth/callback/" +
          provider +
          "?code=" +
          randomUUID() +
          "&state=" +
          encodeURIComponent(started.state),
        {
          headers: { cookie: started.cookie + (extraCookie ? `; ${extraCookie}` : "") },
        },
      ),
    );
  }

  async function complete(provider = "github", invitation: string | undefined = inviteCode) {
    const started = await begin(provider, invitation);
    const response = await finish(started, provider);
    expect(response.headers.get("location")).toBe(`${origin}/dashboard`);
    return { started, response, cookie: cookieJar(response) };
  }

  it("uses signed HttpOnly state and S256 PKCE for both providers and keeps invite data out of OAuth URLs", async () => {
    for (const provider of ["github", "google"]) {
      const started = await begin(provider);
      expect(started.state.length).toBeGreaterThan(20);
      expect(started.authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(started.authorization.searchParams.get("redirect_uri")).toBe(
        `${origin}/api/auth/callback/${provider}`,
      );
      expect(started.authorization.href).not.toContain(inviteCode);
      expect(started.response.headers.getSetCookie().join(";")).not.toContain(inviteCode);
      expect(
        started.response.headers
          .getSetCookie()
          .every(
            (value) =>
              value.includes("HttpOnly") &&
              value.includes("Secure") &&
              value.includes("SameSite=Lax"),
          ),
      ).toBe(true);
    }
  });

  it.each(["github", "google"])(
    "signs in an email-less %s identity through the actual framework callback",
    async (provider) => {
      email = null;
      const fetchEmails = vi.fn(async () => Response.json([]));
      vi.stubGlobal("fetch", fetchEmails);
      const login = await complete(provider);
      const current = await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) });
      expect(current?.user.email).toBeNull();
      expect(current?.user.id).toMatch(/^[0-9a-f-]{36}$/);
      const account = (await client.query<Record<string, unknown>>("SELECT * FROM accounts"))
        .rows[0];
      expect(Object.keys(account).sort()).toEqual(["provider", "provider_account_id", "user_id"]);
      expect(JSON.stringify(account)).not.toContain("synthetic-provider");
      expect(tokenRequests).toBe(1);
      if (provider === "github") {
        expect(fetchEmails).toHaveBeenCalledOnce();
        expect(fetchEmails).toHaveBeenCalledWith("https://api.github.com/user/emails", {
          headers: { authorization: "Bearer synthetic-provider-access-token" },
          redirect: "error",
        });
      } else {
        expect(fetchEmails).not.toHaveBeenCalled();
      }
    },
  );

  it("requires an unused invitation for a new account but permits a returning provider", async () => {
    const missing = await finish(await begin("github", ""));
    expect(new URL(missing.headers.get("location") ?? "").searchParams.get("error")).toBe("invite");
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(0);
    const login = await complete();
    const returned = await complete("github", "");
    expect(
      (await auth.api.getSession({ headers: new Headers({ cookie: returned.cookie }) }))?.user.id,
    ).toBe(
      (await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) }))?.user.id,
    );
  });

  it("rejects a bad signed Google identity token before account creation", async () => {
    invalidSignature = true;
    const response = await finish(await begin("google"), "google");
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/login");
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(0);
  });

  it("rejects missing, forged, expired and deleted-account sessions", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(
      await auth.api.getSession({
        headers: new Headers({ cookie: "__Secure-next-auth.session-token=forged" }),
      }),
    ).toBeNull();
    const login = await complete();
    await client.exec("UPDATE sessions SET expires=now()-interval '1 second'");
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) }),
    ).toBeNull();
    const another = await complete("github", "");
    await client.exec("DELETE FROM users");
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: another.cookie }) }),
    ).toBeNull();
    expect(
      (
        await auth.handler(
          new Request(`${origin}/api/auth/get-session`, { headers: { cookie: another.cookie } }),
        )
      ).status,
    ).toBe(200);
    expect(
      await (
        await auth.handler(
          new Request(`${origin}/api/auth/get-session`, { headers: { cookie: another.cookie } }),
        )
      ).json(),
    ).toBeNull();
  });

  it("revokes a database session on CSRF-protected logout and returns a sanitized session DTO", async () => {
    const login = await complete();
    const session = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, { headers: { cookie: login.cookie } }),
    );
    const dto = await session.json();
    expect(Object.keys(dto).sort()).toEqual(["session", "user"]);
    expect(Object.keys(dto.session)).toEqual(["expiresAt"]);
    expect(Object.keys(dto.user).sort()).toEqual(["email", "id", "name"]);
    expect(await session.text().catch(() => "")).not.toContain("sessionToken");
    const csrf = await auth.handler(
      new Request(`${origin}/api/auth/csrf`, { headers: { cookie: login.cookie } }),
    );
    const logout = await auth.handler(
      new Request(`${origin}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          origin,
          cookie: `${login.cookie}; ${cookieJar(csrf)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ csrfToken: (await csrf.json()).csrfToken }),
      }),
    );
    expect(logout.status).toBe(200);
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) }),
    ).toBeNull();
    expect(
      logout.headers
        .getSetCookie()
        .some(
          (value) =>
            value.includes("session-token=;") &&
            value.includes("HttpOnly") &&
            value.includes("Secure"),
        ),
    ).toBe(true);
  });

  it("rejects a forged CSRF logout and keeps render-time session reads read-only", async () => {
    const login = await complete();
    const failed = await auth.handler(
      new Request(`${origin}/api/auth/sign-out`, {
        method: "POST",
        headers: { origin, cookie: login.cookie, "content-type": "application/json" },
        body: JSON.stringify({ csrfToken: "forged-token" }),
      }),
    );
    expect(failed.status).toBe(403);
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) }),
    ).not.toBeNull();
    await client.exec("UPDATE sessions SET expires=now()+interval '5 days'");
    const before = (await client.query("SELECT expires FROM sessions")).rows;
    await auth.api.getSession({
      headers: new Headers({ cookie: login.cookie }),
      query: { disableRefresh: true },
    });
    expect((await client.query("SELECT expires FROM sessions")).rows).toEqual(before);
    const renewed = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, { headers: { cookie: login.cookie } }),
    );
    expect(renewed.headers.getSetCookie().some((value) => value.includes("session-token="))).toBe(
      true,
    );
    expect(
      (
        await client.query<{ expires: Date }>("SELECT expires FROM sessions")
      ).rows[0].expires.getTime(),
    ).toBeGreaterThan((before[0] as { expires: Date }).expires.getTime());
  });

  it("rejects forged signed context and invalid state or PKCE cookies before provisioning", async () => {
    const started = await begin();
    const forged = started.cookie.replace(/(monitrail\.oauth-context=)[^;]+/, "$1forged.value");
    const invalidContext = await auth.handler(
      new Request(`${origin}/api/auth/callback/github?code=fixture&state=${started.state}`, {
        headers: { cookie: forged },
      }),
    );
    expect(new URL(invalidContext.headers.get("location") ?? "").pathname).toBe("/login");
    expect(tokenRequests).toBe(0);
    const noPkce = started.cookie
      .split("; ")
      .filter((pair) => !pair.startsWith("__Secure-next-auth.pkce."))
      .join("; ");
    const invalidPkce = await auth.handler(
      new Request(`${origin}/api/auth/callback/github?code=fixture&state=${started.state}`, {
        headers: { cookie: noPkce },
      }),
    );
    expect(new URL(invalidPkce.headers.get("location") ?? "").pathname).toBe("/login");
    expect(tokenRequests).toBe(0);
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(0);
  });

  it("returns an unavailable session response when its database lookup fails", async () => {
    const login = await complete();
    const adapter = auth.options.adapter;
    if (!adapter) throw new Error("Missing fixture adapter.");
    adapter.getSessionAndUser = async () => {
      throw new Error("synthetic credential diagnostic");
    };
    const response = await auth.handler(
      new Request(`${origin}/api/auth/get-session`, {
        headers: { cookie: login.cookie },
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("diagnostic");
  });

  it("cannot reset admission by spoofing forwarded client addresses", async () => {
    const csrf = await auth.handler(new Request(`${origin}/api/auth/csrf`));
    const token = (await csrf.json()).csrfToken;
    const statuses = [];
    for (const forwarded of ["192.0.2.1", "192.0.2.2", "198.51.100.2", "203.0.113.9"]) {
      const response = await auth.handler(
        new Request(`${origin}/api/auth/sign-in/social`, {
          method: "POST",
          headers: {
            origin,
            cookie: cookieJar(csrf),
            "content-type": "application/json",
            "x-forwarded-for": forwarded,
            "x-real-ip": forwarded,
            "x-vercel-forwarded-for": forwarded,
          },
          body: JSON.stringify({ provider: "github", csrfToken: token, callbackURL: "/dashboard" }),
        }),
      );
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("binds invitation context to provider and OAuth state and consumes it once", async () => {
    const started = await begin();
    const missing = await auth.handler(
      new Request(`${origin}/api/auth/callback/github?code=fixture&state=${started.state}`),
    );
    expect(new URL(missing.headers.get("location") ?? "").pathname).toBe("/login");
    expect(tokenRequests).toBe(0);
    const wrongProvider = await finish(started, "google");
    expect(new URL(wrongProvider.headers.get("location") ?? "").pathname).toBe("/login");
    expect(tokenRequests).toBe(0);
    const valid = await finish(started);
    expect(valid.headers.get("location")).toBe(`${origin}/dashboard`);
    const replayed = await finish(started);
    expect(new URL(replayed.headers.get("location") ?? "").pathname).toBe("/login");
    expect(tokenRequests).toBe(1);
  });

  it("refuses email linking and provider switching inside another account session", async () => {
    const login = await complete();
    profileId = "other";
    const collision = await finish(await begin("google"), "google");
    expect(new URL(collision.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "account_conflict",
    );
    email = "other@example.invalid";
    const linked = await finish(await begin(), "github", login.cookie);
    expect(new URL(linked.headers.get("location") ?? "").searchParams.get("error")).toBe(
      "account_conflict",
    );
    expect((await client.query("SELECT * FROM accounts")).rows).toHaveLength(1);
  });
});
