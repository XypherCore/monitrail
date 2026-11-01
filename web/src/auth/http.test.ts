import { describe, expect, it, vi } from "vitest";
import { createAuthRequestHandler } from "./http.ts";

const origin = "https://app.example.invalid";
function fixture() {
  const handler = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname.endsWith("get-session")) return Response.json({ user: { id: "owner", name: "Fixture", email: "fixture@example.invalid", emailVerified: true }, session: { token: "must-not-leak", expiresAt: new Date("2099-01-01") } }, { headers: { "set-cookie": "fixture=renewed; HttpOnly; Secure" } });
    return Response.json({ url: "https://github.com/login/oauth/authorize?state=fixture", redirect: true });
  });
  return { handler, handle: createAuthRequestHandler({ handler }, origin) };
}
function post(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/auth/sign-in/social`, { method: "POST", headers: { origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
describe("public authentication boundary", () => {
  it("blocks unneeded token, account and mutation endpoints", async () => {
    const f = fixture();
    for (const path of ["get-access-token", "refresh-token", "list-accounts", "link-social", "update-user", "sign-up/email", "delete-user"]) {
      expect((await f.handle(new Request(`${origin}/api/auth/${path}`, { method: "POST" }))).status).toBe(404);
    }
    expect(f.handler).not.toHaveBeenCalled();
  });
  it("requires exact same origin for sign-in and logout", async () => {
    const f = fixture();
    for (const requestOrigin of ["https://evil.example", "null", ""]) expect((await f.handle(post({ provider: "github", callbackURL: "/dashboard" }, requestOrigin))).status).toBe(403);
    expect((await f.handle(new Request(`${origin}/api/auth/sign-out`, { method: "POST" }))).status).toBe(403);
    expect(f.handler).not.toHaveBeenCalled();
  });
  it("refuses arbitrary providers, direct tokens, extra scopes and unsafe destinations", async () => {
    const f = fixture();
    for (const body of [null, [], { provider: "evil" }, { provider: "github", idToken: { token: "fixture" } }, { provider: "github", scopes: ["repo"] }, { provider: "github", callbackURL: "https://evil.example" }]) {
      expect((await f.handle(post(body))).status).toBe(400);
    }
    expect(f.handler).not.toHaveBeenCalled();
  });
  it("does not return persisted session tokens or user metadata", async () => {
    const f = fixture();
    const response = await f.handle(new Request(`${origin}/api/auth/get-session`));
    expect(await response.json()).toEqual({ user: { id: "owner", name: "Fixture", email: "fixture@example.invalid" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("set-cookie")).toContain("fixture=renewed");
  });
  it("bounds input size and hides dependency exceptions", async () => {
    const f = fixture();
    expect((await f.handle(post({ provider: "github", callbackURL: "x".repeat(9000) }))).status).toBe(413);
    f.handler.mockRejectedValueOnce(new Error("postgresql://fixture:synthetic-secret@db.example.invalid/auth"));
    const response = await f.handle(post({ provider: "github", callbackURL: "/dashboard" }));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-secret");
  });
  it("replaces provider errors with a generic local error redirect", async () => {
    const f = fixture();
    f.handler.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `${origin}/login?error_description=synthetic-secret`, "set-cookie": "fixture=cleared; HttpOnly; Secure" } }));
    const response = await f.handle(new Request(`${origin}/api/auth/callback/github?code=fixture&state=fixture`));
    expect(response.headers.get("location")).toBe(`${origin}/login?error=oauth`);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });
});
