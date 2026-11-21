import { describe, expect, it } from "vitest";
import {
  createPageSecurity,
  baselineSecurityHeaders,
  contentSecurityPolicy,
} from "./headers.ts";

function directive(policy: string, name: string) {
  return policy.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
}

describe("browser security headers", () => {
  it("creates a fresh server nonce and replaces caller-supplied CSP and nonce headers", () => {
    const original = new Headers({
      "content-security-policy": "script-src * 'unsafe-inline'",
      "x-nonce": "attacker",
      cookie: "fixture-session",
    });
    const first = createPageSecurity(original, false);
    const second = createPageSecurity(original, false);
    expect(first.nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.requestHeaders.get("x-nonce")).toBe(first.nonce);
    expect(first.requestHeaders.get("content-security-policy")).toBe(first.policy);
    expect(first.requestHeaders.get("cookie")).toBe("fixture-session");
    expect(first.policy).not.toContain("attacker");
    expect(original.get("x-nonce")).toBe("attacker");
  });

  it("allows only nonce-authorized production scripts and app connections", () => {
    const { nonce, policy } = createPageSecurity(new Headers(), false);
    expect(directive(policy, "script-src")).toBe(`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`);
    expect(directive(policy, "script-src-attr")).toBe("script-src-attr 'none'");
    expect(directive(policy, "connect-src")).toBe("connect-src 'self'");
    expect(directive(policy, "object-src")).toBe("object-src 'none'");
    expect(directive(policy, "base-uri")).toBe("base-uri 'none'");
    expect(directive(policy, "form-action")).toBe("form-action 'self'");
    expect(directive(policy, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(policy, "style-src")).toBe(`style-src 'self' 'nonce-${nonce}'`);
    expect(directive(policy, "style-src-elem")).toBe(`style-src-elem 'self' 'nonce-${nonce}'`);
    expect(directive(policy, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
    expect(policy).not.toContain("unsafe-eval");
    expect(policy).not.toMatch(/https?:|wss?:|\*/);
  });

  it("limits development eval and websocket allowances to development", () => {
    const production = createPageSecurity(new Headers(), false).policy;
    const development = createPageSecurity(new Headers(), true).policy;
    expect(directive(development, "script-src")).toContain("'unsafe-eval'");
    expect(directive(development, "connect-src")).toBe("connect-src 'self' ws: wss:");
    expect(directive(development, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(production).not.toContain("unsafe-eval");
    expect(production).not.toContain("ws:");
  });

  it("rejects malformed nonces rather than interpolating directives", () => {
    for (const nonce of ["", "nonce", "'; script-src *", "\ninvalid", "<tag>"]) {
      expect(() => contentSecurityPolicy(nonce, false)).toThrow("Invalid page security configuration.");
    }
  });

  it("covers every response with framing, sniffing, referrer and production transport protection", () => {
    expect(baselineSecurityHeaders(true)).toEqual({
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=31536000",
    });
    expect(baselineSecurityHeaders(false)).not.toHaveProperty("strict-transport-security");
  });
});
