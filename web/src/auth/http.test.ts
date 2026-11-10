import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthRequestHandler, type OAuthContext } from "./http.ts";

const origin = "https://app.example.invalid";
const state = "synthetic-provider-state-for-isolated-tests";
const csrfToken = "csrf-fixture-token";
const secret = "synthetic-auth-secret-for-http-fixtures-only";

function fixture() {
  const rawHandler = vi.fn<(request: Request, context?: OAuthContext) => Promise<Response>>(
    async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/session"))
        return Response.json(
          {
            user: { id: "fixture-owner", name: "Fixture", email: null, token: "must-not-leak" },
            expires: "2099-01-01T00:00:00.000Z",
            token: "must-not-leak",
          },
          { headers: { "set-cookie": "fixture=renewed; HttpOnly; Secure" } },
        );
      if (path.endsWith("/csrf")) return Response.json({ csrfToken });
      if (path.includes("/callback/"))
        return new Response(null, {
          status: 302,
          headers: {
            location: `${origin}/dashboard`,
            "set-cookie": "fixture=cleared; HttpOnly; Secure",
          },
        });
      return Response.json({ url: `https://github.com/login/oauth/authorize?state=${state}` });
    },
  );
  const limits = {
    consume: vi.fn(async () => ({ allowed: true, retryAfter: null as number | null })),
    reserveOAuthState: vi.fn(async () => {}),
    consumeOAuthState: vi.fn(async () => true),
  };
  const config = {
    baseURL: origin,
    secret,
    signupMode: "invite" as const,
    github: { clientId: "test-only", clientSecret: "test-only" },
    google: { clientId: "test-only", clientSecret: "test-only" },
  };
  const handle = createAuthRequestHandler({ rawHandler, config, limits }, origin);
  async function start() {
    const response = await handle(
      post({
        provider: "github",
        callbackURL: "/dashboard",
        csrfToken,
        inviteCode: "private-fixture-code",
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  }
  return { rawHandler, limits, handle, start };
}

function post(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.useRealTimers());

describe("public Auth.js request boundary", () => {
  it("exposes only the documented OAuth, CSRF, session and signout endpoints", async () => {
    const f = fixture();
    for (const path of [
      "get-access-token",
      "refresh-token",
      "list-accounts",
      "link-social",
      "update-user",
      "sign-up/email",
      "delete-user",
      "signin/github",
      "session",
      "providers",
    ]) {
      expect(
        (await f.handle(new Request(`${origin}/api/auth/${path}`, { method: "POST" }))).status,
      ).toBe(404);
    }
    expect(f.rawHandler).not.toHaveBeenCalled();
  });

  it("requires exact Origin and appropriate methods", async () => {
    const f = fixture();
    for (const requestOrigin of ["https://evil.example", "null", ""]) {
      expect((await f.handle(post({ provider: "github", csrfToken }, requestOrigin))).status).toBe(
        403,
      );
    }
    expect(
      (await f.handle(new Request(`${origin}/api/auth/sign-out`, { method: "POST" }))).status,
    ).toBe(403);
    expect(
      (await f.handle(new Request(`${origin}/api/auth/callback/github`, { method: "POST" })))
        .status,
    ).toBe(405);
    expect(f.rawHandler).not.toHaveBeenCalled();
  });

  it("refuses client tokens, scopes, unsupported providers and unsafe callback paths", async () => {
    const f = fixture();
    for (const body of [
      null,
      [],
      { provider: "evil", csrfToken },
      { provider: "github", idToken: "fake", csrfToken },
      { provider: "github", scopes: ["repo"], csrfToken },
      { provider: "github", callbackURL: "https://evil.example", csrfToken },
      { provider: "github", callbackURL: "//evil.example", csrfToken },
      { provider: "github" },
    ]) {
      expect((await f.handle(post(body))).status).toBe(400);
    }
    expect(f.rawHandler).not.toHaveBeenCalled();
  });

  it("returns only the public session projection while forwarding renewal cookies", async () => {
    const f = fixture();
    const response = await f.handle(new Request(`${origin}/api/auth/get-session`));
    expect(await response.json()).toEqual({
      user: { id: "fixture-owner", name: "Fixture", email: null },
      session: { expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toContain("fixture=renewed");
  });

  it("rejects oversized and malformed bodies and hides dependency failures", async () => {
    const f = fixture();
    expect(
      (await f.handle(post({ provider: "github", csrfToken, inviteCode: "x".repeat(9000) })))
        .status,
    ).toBe(413);
    f.rawHandler.mockRejectedValueOnce(new Error("fake credential diagnostic"));
    const response = await f.handle(post({ provider: "github", csrfToken }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("diagnostic");
  });

  it("bounds a chunked upload even if its source ignores cancellation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const input = new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: new ReadableStream({
        pull() {
          return new Promise<void>(() => {});
        },
      }),
      duplex: "half",
    } as RequestInit);
    const pending = f.handle(input);
    await vi.runAllTimersAsync();
    expect((await pending).status).toBe(408);
    expect(f.rawHandler).not.toHaveBeenCalled();
  });

  it("binds a hashed invitation to state and provider in an HttpOnly cookie", async () => {
    const f = fixture();
    const cookie = await f.start();
    expect(cookie).not.toContain("private-fixture-code");
    const result = await f.handle(
      new Request(`${origin}/api/auth/callback/github?state=${state}&code=fixture`, {
        headers: { cookie },
      }),
    );
    expect(result.headers.get("location")).toBe(`${origin}/dashboard`);
    const context = f.rawHandler.mock.calls[1][1];
    expect(context).toMatchObject({
      provider: "github",
      inviteHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      nextPath: "/dashboard",
    });
    expect(result.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
    expect(f.limits.consumeOAuthState).toHaveBeenCalledOnce();
  });

  it("rejects absent, wrong-state, wrong-provider and forged context before OAuth work", async () => {
    const f = fixture();
    const cookie = await f.start();
    const signatureStart = cookie.lastIndexOf(".") + 1;
    const replacement = cookie[signatureStart] === "A" ? "B" : "A";
    const forged = `${cookie.slice(0, signatureStart)}${replacement}${cookie.slice(signatureStart + 1)}`;
    f.rawHandler.mockClear();
    for (const [provider, returned, context] of [
      ["github", state, ""],
      ["github", "different-state", cookie],
      ["google", state, cookie],
      ["github", state, forged],
    ]) {
      const response = await f.handle(
        new Request(`${origin}/api/auth/callback/${provider}?state=${returned}&code=fixture`, {
          headers: { cookie: context },
        }),
      );
      expect(response.headers.get("location")).toBe(`${origin}/login?error=oauth`);
    }
    expect(f.rawHandler).not.toHaveBeenCalled();
    expect(f.limits.consumeOAuthState).not.toHaveBeenCalled();
  });

  it("refuses replayed context and sanitizes callback errors and destinations", async () => {
    const f = fixture();
    const cookie = await f.start();
    f.limits.consumeOAuthState.mockResolvedValueOnce(false);
    const callback = () =>
      new Request(`${origin}/api/auth/callback/github?state=${state}&code=fixture`, {
        headers: { cookie },
      });
    expect((await f.handle(callback())).headers.get("location")).toBe(
      `${origin}/login?error=oauth`,
    );
    f.rawHandler.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: {
          location: "https://evil.example/?secret=fake-private-detail",
        },
      }),
    );
    const rejected = await f.handle(callback());
    expect(rejected.headers.get("location")).toBe(`${origin}/login?error=oauth`);
    expect(await rejected.text()).not.toContain("fake-private-detail");
  });

  it("returns a bounded Retry-After on durable admission refusal", async () => {
    const f = fixture();
    f.limits.consume.mockResolvedValueOnce({ allowed: false, retryAfter: 8 });
    const response = await f.handle(post({ provider: "github", csrfToken }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8");
    expect(f.rawHandler).not.toHaveBeenCalled();
  });
});
