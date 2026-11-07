import { describe, expect, it } from "vitest";
import { canonicalPolicyHost, parseTarget, parseWebhookTarget } from "./address.ts";
import { isBlockedHost, prepareBlocklist } from "./blocklist.ts";

describe("profile URL rules", () => {
  it.each([
    "http://service.example/",
    "https://service.example:80/",
    "http://service.example:443/",
    "http://service.example:8080/",
    "https://service.example:8443/",
  ])("accepts a monitor port for %s", (value) => {
    expect(parseTarget(value, "monitor").hostname).toBe("service.example");
  });

  it.each([
    "http://service.example:443/hook",
    "http://service.example/hook",
    "https://service.example:80/hook",
    "https://service.example:8080/hook",
    "https://service.example:8443/hook",
    "https://user:password@service.example/hook",
    "https://[::ffff:127.0.0.1]/hook",
  ])("rejects a webhook outside HTTPS port 443: %s", (value) => {
    expect(() => parseWebhookTarget(value, "webhook")).toThrow("Target URL is not allowed.");
  });

  it.each(["https://service.example/hook", "https://service.example:443/hook?token=test-only"])(
    "accepts generic HTTPS webhooks on the effective default port",
    (value) => expect(parseWebhookTarget(value, "webhook").hostname).toBe("service.example"),
  );

  it("accepts the approved provider host and literal path forms", () => {
    expect(
      parseWebhookTarget("https://hooks.slack.com/services/T1/B2/test-only", "slack").hostname,
    ).toBe("hooks.slack.com");
    expect(
      parseWebhookTarget("https://discord.com:443/api/webhooks/123/test_only", "discord").hostname,
    ).toBe("discord.com");
  });

  it.each([
    ["https://hooks.slack.com.evil.example/services/T1/B2/test-only", "slack"],
    ["https://a.hooks.slack.com/services/T1/B2/test-only", "slack"],
    ["https://hooks.slack-gov.com/services/T1/B2/test-only", "slack"],
    ["https://hooks.slack.com./services/T1/B2/test-only", "slack"],
    ["https://%68ooks.slack.com/services/T1/B2/test-only", "slack"],
    ["https://hooks.slack.com/services/T1/B2/test-only/extra", "slack"],
    ["https://hooks.slack.com/services/T1//test-only", "slack"],
    ["https://hooks.slack.com/services/%54%31/B2/test-only", "slack"],
    ["https://hooks.slack.com/services/T1/B2/test%2Fonly", "slack"],
    ["https://hooks.slack.com/extra/../services/T1/B2/test-only", "slack"],
    ["https://hooks.slack.com/services/T1/B2/test-only?", "slack"],
    ["https://hooks.slack.com/services/T1/B2/test-only#part", "slack"],
    ["https://discordapp.com/api/webhooks/123/test-only", "discord"],
    ["https://discord.com/api/v10/webhooks/123/test-only", "discord"],
    ["https://discord.com/api/webhooks/123/test-only/slack", "discord"],
    ["https://discord.com/api/webhooks/abc/test-only", "discord"],
    ["https://discord.com/api/webhooks/123/test-only?wait=true", "discord"],
  ] as const)("rejects a provider alias or alternate path: %s", (value, provider) => {
    expect(() => parseWebhookTarget(value, provider)).toThrow("Target URL is not allowed.");
  });
});

describe("canonical blocklist policy", () => {
  it.each([
    ["WWW.Example.COM.", "www.example.com"],
    ["Bücher.example", "xn--bcher-kva.example"],
    ["0x08080808", "8.8.8.8"],
    ["[::FFFF:808:808]", "8.8.8.8"],
    ["::ffff:8.8.8.8", "8.8.8.8"],
    ["2606:4700:4700:0:0:0:0:1111", "[2606:4700:4700::1111]"],
    ["localhost", null],
    ["a%2eb.example", null],
  ])("normalizes policy key %s", (input, expected) => {
    expect(canonicalPolicyHost(input)).toBe(expected);
  });

  it("matches exact hosts and optional subdomains on label boundaries", () => {
    const blocked = prepareBlocklist([
      { host: "ExAmPlE.COM.", includeSubdomains: true },
      { host: "exact.example", includeSubdomains: false },
      { host: "Bücher.example.", includeSubdomains: true },
    ]);
    expect(blocked("example.com")).toBe(true);
    expect(blocked("a.b.EXAMPLE.com.")).toBe(true);
    expect(blocked("notexample.com")).toBe(false);
    expect(blocked("example.com.evil.example")).toBe(false);
    expect(blocked("exact.example")).toBe(true);
    expect(blocked("a.exact.example")).toBe(false);
    expect(blocked("a.xn--bcher-kva.example")).toBe(true);
  });

  it("uses one policy key for plain and mapped IPv4", () => {
    expect(
      isBlockedHost("[::ffff:8.8.8.8]", [{ host: "0x08080808", includeSubdomains: false }]),
    ).toBe(true);
    expect(isBlockedHost("8.8.8.8", [{ host: "::ffff:808:808", includeSubdomains: true }])).toBe(
      true,
    );
  });

  it.each([
    null,
    {},
    [null],
    [{ host: "https://example.com", includeSubdomains: true }],
    [{ host: "example.com" }],
  ])("fails closed on a missing or invalid snapshot", (snapshot) => {
    expect(() => prepareBlocklist(snapshot)).toThrow("Invalid blocklist snapshot.");
    expect(isBlockedHost("public.example", snapshot)).toBe(true);
  });

  it("copies snapshot policy and fails closed on a malformed candidate", () => {
    const entries = [{ host: "example.com", includeSubdomains: false }];
    const blocked = prepareBlocklist(entries);
    entries[0].host = "other.example";
    expect(blocked("example.com")).toBe(true);
    expect(blocked("https://public.example/")).toBe(true);
  });
});
