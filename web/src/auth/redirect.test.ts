import { describe, expect, it } from "vitest";
import { sanitizeNextPath } from "./redirect.ts";

describe("login return paths", () => {
  it.each([undefined, null, [], {}, "", "https://evil.example", "//evil.example", "/\\evil.example", "/%2f%2fevil.example", "/dashboard\n", "/api/auth/sign-out", "/login?next=/login", "/dashboard#fragment", "/dashboard?token=secret", "/dashboard/../api/auth/get-access-token"])("rejects unsafe destinations", value => {
    expect(sanitizeNextPath(value)).toBe("/dashboard");
  });
  it.each(["/dashboard", "/channels", "/status-pages", "/settings", "/monitors/new", "/monitors/10000000-0000-4000-8000-000000000001"])("permits documented application paths: %s", value => {
    expect(sanitizeNextPath(value)).toBe(value);
  });
});
