import { describe, expect, it } from "vitest";
import { checkerUserAgent, identity } from "./identity.ts";

describe("project identity", () => {
  it("uses one brand across the footer, attribution and checker", () => {
    expect(identity.footerText).toBe(identity.brandName);
    expect(identity.poweredByText).toBe(`Powered by ${identity.brandName}`);
    expect(checkerUserAgent("https://example.test/")).toBe(
      `${identity.brandName}/1.0 (+https://example.test/bot)`,
    );
    expect(checkerUserAgent("http://localhost:3000")).toBe(
      `${identity.brandName}/1.0 (+http://localhost:3000/bot)`,
    );
  });

  it.each([
    "",
    "ftp://example.test",
    "https://@example.test",
    "https://user:password@example.test",
    "https://example.test/prefix",
    "https://example.test?",
    "https://example.test#",
    "https://example.test\r\n",
    "https://example.test:99999",
  ])("rejects a non-origin checker address", (value) => {
    expect(() => checkerUserAgent(value)).toThrow("Invalid application origin.");
  });

  it("reads the optional abuse alias from environment input only", () => {
    expect(identity.abuseContactEmail({})).toBeUndefined();
    expect(identity.abuseContactEmail({ ABUSE_CONTACT_EMAIL: "abuse@example.test" })).toBe(
      "abuse@example.test",
    );
    expect(identity.abuseContactEmail({ ABUSE_CONTACT_EMAIL: "abuse@example.test?subject=x" }))
      .toBeUndefined();
  });
});
