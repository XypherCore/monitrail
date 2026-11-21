import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy.ts";

const { session, published } = vi.hoisted(() => ({
  session: vi.fn(),
  published: vi.fn(),
}));
vi.mock("../auth/config.ts", () => ({
  readAuthConfig: () => ({ baseURL: "https://app.example.invalid" }),
}));
vi.mock("../auth/runtime.ts", () => ({
  getAuthRuntime: () => ({ api: { getSession: session } }),
}));
vi.mock("../status-pages/public-runtime.ts", () => ({
  hasPublicStatusPage: published,
}));

beforeEach(() => {
  session.mockReset().mockResolvedValue(null);
  published.mockReset().mockResolvedValue(false);
});

function request(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`https://app.example.invalid${path}`, { headers });
}

function expectPagePolicy(response: Response) {
  expect(response.headers.get("content-security-policy")).toContain("'strict-dynamic'");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}

describe("page proxy security", () => {
  it("forwards a new nonce on public pages while replacing hostile policy headers", async () => {
    const response = await proxy(request("/", {
      "content-security-policy": "script-src * 'unsafe-inline'",
      "x-nonce": "untrusted",
    }));
    const policy = response.headers.get("content-security-policy");
    expect(response.status).toBe(200);
    expectPagePolicy(response);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(policy).toContain(`'nonce-${response.headers.get("x-middleware-request-x-nonce")}'`);
    expect(policy).not.toContain("untrusted");
    expect(session).not.toHaveBeenCalled();
  });

  it.each(["/dashboard", "/monitors/new", "/channels", "/status-pages", "/settings"])(
    "keeps anonymous prefetches for %s behind authentication", async (path) => {
      const response = await proxy(request(path, { "next-router-prefetch": "1", purpose: "prefetch" }));
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toBe(
        `https://app.example.invalid/login?next=${encodeURIComponent(path)}`,
      );
      expectPagePolicy(response);
      expect(session).toHaveBeenCalledOnce();
    },
  );

  it("lets validated sessions continue with nonce headers and fails closed on auth errors", async () => {
    session.mockResolvedValueOnce({ user: { id: "fixture-user" } });
    const valid = await proxy(request("/dashboard"));
    expect(valid.status).toBe(200);
    expectPagePolicy(valid);
    expect(valid.headers.get("x-middleware-request-content-security-policy")).toBe(
      valid.headers.get("content-security-policy"),
    );
    session.mockRejectedValueOnce(new Error("private-fixture-error"));
    const failed = await proxy(request("/dashboard"));
    expect(failed.status).toBe(503);
    expectPagePolicy(failed);
    expect(await failed.text()).not.toContain("private-fixture-error");
  });

  it("retains the identical generic 404 for draft and missing status pages", async () => {
    const draft = await proxy(request("/status/draft-fixture"));
    const missing = await proxy(request("/status/missing-fixture"));
    expect(draft.status).toBe(404);
    expect(missing.status).toBe(404);
    expectPagePolicy(draft);
    expectPagePolicy(missing);
    expect(await draft.text()).toBe(await missing.text());
    expect(session).not.toHaveBeenCalled();
  });

  it("forwards nonce headers for public status pages and masks a failed visibility lookup", async () => {
    published.mockResolvedValueOnce(true);
    const visible = await proxy(request("/status/visible-fixture"));
    expect(visible.status).toBe(200);
    expectPagePolicy(visible);
    expect(visible.headers.get("x-middleware-request-content-security-policy")).toBe(
      visible.headers.get("content-security-policy"),
    );
    published.mockRejectedValueOnce(new Error("private-database-error"));
    const failed = await proxy(request("/status/visible-fixture"));
    expect(failed.status).toBe(503);
    expectPagePolicy(failed);
    expect(await failed.text()).not.toContain("private-database-error");
  });
});
