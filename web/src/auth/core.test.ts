import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { symmetricDecrypt } from "better-auth/crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthCore } from "./core.ts";
import { createAuthRequestHandler } from "./http.ts";

const origin = "https://app.example.invalid";
const config = {
  baseURL: origin,
  secret: "synthetic-auth-secret-for-isolated-tests-only",
  github: { clientId: "fixture-github", clientSecret: "fixture-github-secret" },
  google: { clientId: "fixture-google", clientSecret: "fixture-google-secret" },
};
const accessToken = "synthetic-provider-access-token";
const refreshToken = "synthetic-provider-refresh-token";

function cookies(response: Response): string {
  return response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
}

describe("OAuth and database session security", () => {
  let client: PGlite;
  let auth: ReturnType<typeof createAuthCore>;
  let verified = true;

  beforeAll(async () => {
    client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  }, 30_000);
  beforeEach(async () => {
    await client.exec("TRUNCATE users, verification CASCADE");
    auth = createAuthCore(drizzle(client), config);
    verified = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: accessToken, refresh_token: refreshToken, token_type: "bearer", scope: "read:user,user:email" });
      if (url === "https://api.github.com/user") return Response.json({ id: 42, login: "fixture", name: "Fixture OAuth user", email: null, avatar_url: "https://avatars.example.invalid/fixture.png" });
      if (url === "https://api.github.com/user/emails") return Response.json([{ email: "oauth@example.invalid", primary: true, verified }]);
      throw new Error("Unexpected outbound request in isolated auth test.");
    }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  afterAll(async () => { await client?.close(); });

  async function begin(provider = "github"): Promise<{ state: string; cookie: string; response: Response; authorization: URL }> {
    const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider, callbackURL: "/dashboard", errorCallbackURL: "/login?error=oauth" }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json();
    const authorization = new URL(body.url);
    return { state: authorization.searchParams.get("state") ?? "", cookie: cookies(response), response, authorization };
  }
  async function complete(provider = "github") {
    const started = await begin(provider);
    const response = await auth.handler(new Request(`${origin}/api/auth/callback/${provider}?code=fixture-code&state=${encodeURIComponent(started.state)}`, { headers: { cookie: started.cookie } }));
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "", origin).href).toBe(`${origin}/dashboard`);
    return { response, cookie: cookies(response), state: started.state, stateCookie: started.cookie };
  }

  it("uses state, S256 PKCE and signed HttpOnly state cookies for both providers", async () => {
    for (const provider of ["github", "google"]) {
      const started = await begin(provider);
      expect(started.state.length).toBeGreaterThan(20);
      expect(started.authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(started.authorization.searchParams.get("code_challenge")).toBeTruthy();
      expect(started.authorization.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/callback/${provider}`);
      const setCookie = started.response.headers.getSetCookie().join(";");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("Secure");
      expect(setCookie).toContain("SameSite=Lax");
    }
  });
  it("authenticates a verified provider profile, encrypts provider tokens and stores no password", async () => {
    const login = await complete();
    const session = await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) });
    expect(session?.user.email).toBe("oauth@example.invalid");
    expect(session?.user.id).toMatch(/^[0-9a-f-]{36}$/);
    const tokens = (await client.query<{ access_token: string; refresh_token: string; id_token: string | null; password: string | null }>("SELECT access_token,refresh_token,id_token,password FROM accounts")).rows[0];
    expect(tokens.access_token).not.toContain(accessToken);
    expect(tokens.refresh_token).not.toContain(refreshToken);
    expect(await symmetricDecrypt({ key: config.secret, data: tokens.access_token })).toBe(accessToken);
    expect(await symmetricDecrypt({ key: config.secret, data: tokens.refresh_token })).toBe(refreshToken);
    expect(tokens.id_token).toBeNull();
    expect(tokens.password).toBeNull();
    expect(login.response.headers.getSetCookie().join(";")).toMatch(/HttpOnly/);
  });
  it("rejects missing, forged and expired sessions", async () => {
    expect(await auth.api.getSession({ headers: new Headers() })).toBeNull();
    expect(await auth.api.getSession({ headers: new Headers({ cookie: "__Secure-better-auth.session_token=forged.signature" }) })).toBeNull();
    const login = await complete();
    await client.query("UPDATE sessions SET expires_at=now()-interval '1 minute'");
    expect(await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) })).toBeNull();
  });
  it("validates a signed Google identity token and discards it after provisioning", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "fixture-key" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", aud: config.google.clientId, sub: "fixture-google-user", email: "google@example.invalid", email_verified: true, name: "Fixture Google user", iat: now, exp: now + 3600 })).toString("base64url");
    const input = `${header}.${payload}`;
    const token = `${input}.${createSign("RSA-SHA256").update(input).sign(privateKey, "base64url")}`;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: accessToken, refresh_token: refreshToken, id_token: token, expires_in: 3600, token_type: "bearer" });
      if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture-key", alg: "RS256", use: "sig" }] });
      throw new Error("Unexpected outbound request in Google auth test.");
    }));
    const login = await complete("google");
    expect((await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) }))?.user.email).toBe("google@example.invalid");
    expect((await client.query("SELECT id_token FROM accounts")).rows).toEqual([{ id_token: null }]);
  });
  it("revokes the persisted session on logout", async () => {
    const login = await complete();
    const logout = await auth.handler(new Request(`${origin}/api/auth/sign-out`, { method: "POST", headers: { cookie: login.cookie, origin, "content-type": "application/json" }, body: "{}" }));
    expect(logout.status).toBe(200);
    expect((await client.query("SELECT id FROM sessions")).rows).toHaveLength(0);
    expect(await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }) })).toBeNull();
  });
  it("keeps read-only checks read-only and forwards renewed browser cookies through the public session endpoint", async () => {
    const login = await complete();
    await client.query("UPDATE sessions SET expires_at=now()+interval '5 days',updated_at=now()-interval '2 days',created_at=now()-interval '2 days'");
    const before = (await client.query<{ expires_at: Date }>("SELECT expires_at FROM sessions")).rows[0].expires_at;
    expect(await auth.api.getSession({ headers: new Headers({ cookie: login.cookie }), query: { disableRefresh: true } })).not.toBeNull();
    expect((await client.query<{ expires_at: Date }>("SELECT expires_at FROM sessions")).rows[0].expires_at).toEqual(before);
    const response = await createAuthRequestHandler(auth, origin)(new Request(`${origin}/api/auth/get-session`, { headers: { cookie: login.cookie } }));
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join(";")).toContain("session_token=");
    expect((await client.query<{ expires_at: Date }>("SELECT expires_at FROM sessions")).rows[0].expires_at.getTime()).toBeGreaterThan(before.getTime());
    expect(await response.text()).not.toContain("\"token\"");
  });
  it("rejects callbacks without matching signed state cookies and replayed codes", async () => {
    const started = await begin();
    const missing = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=fixture-code&state=${started.state}`));
    expect(new URL(missing.headers.get("location") ?? "", origin).pathname).toBe("/login");
    expect((await client.query("SELECT id FROM sessions")).rows).toHaveLength(0);
    const login = await complete();
    const replay = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=fixture-code&state=${login.state}`, { headers: { cookie: login.stateCookie } }));
    expect(new URL(replay.headers.get("location") ?? "", origin).pathname).toBe("/login");
    expect((await client.query("SELECT id FROM sessions")).rows).toHaveLength(1);
  });
  it("refuses foreign origins on cookie-bearing requests and external callback destinations", async () => {
    for (const body of [{ provider: "github", callbackURL: "https://evil.example" }, { provider: "github", callbackURL: "/dashboard" }]) {
      const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, { method: "POST", headers: { origin: "https://evil.example", cookie: "fixture=present", "content-type": "application/json" }, body: JSON.stringify(body) }));
      expect(response.status).toBe(403);
    }
    const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/social`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ provider: "github", callbackURL: "https://evil.example" }) }));
    expect(response.status).toBe(403);
  });
  it("does not link a provider into an existing account with the same email", async () => {
    const owner = randomUUID();
    await client.query("INSERT INTO users(id,email,name,email_verified) VALUES($1,'oauth@example.invalid','Existing owner',true)", [owner]);
    await client.query("INSERT INTO accounts(user_id,provider_id,account_id) VALUES($1,'google','existing-google')", [owner]);
    const started = await begin();
    const response = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=fixture-code&state=${started.state}`, { headers: { cookie: started.cookie } }));
    expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/login");
    expect((await client.query("SELECT id FROM accounts")).rows).toHaveLength(1);
    expect((await client.query("SELECT id FROM sessions")).rows).toHaveLength(0);
  });
  it("rejects unverified provider email before creating a usable account", async () => {
    verified = false;
    const started = await begin();
    const response = await auth.handler(new Request(`${origin}/api/auth/callback/github?code=fixture-code&state=${started.state}`, { headers: { cookie: started.cookie } }));
    expect(new URL(response.headers.get("location") ?? "", origin).pathname).toBe("/login");
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(0);
    expect((await client.query("SELECT id FROM sessions")).rows).toHaveLength(0);
  });
  it("enforces the framework's default social sign-in limit through durable storage", async () => {
    const handle = createAuthRequestHandler(auth, origin);
    const responses: Response[] = [];
    for (let i = 0; i < 4; i++) responses.push(await handle(new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST", headers: { origin, "content-type": "application/json", "x-forwarded-for": "192.0.2.42" },
      body: JSON.stringify({ provider: "github", callbackURL: "/dashboard" }),
    })));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 429]);
    expect(Number(responses[3].headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
