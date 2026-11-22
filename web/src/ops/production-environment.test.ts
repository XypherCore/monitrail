import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { assertNoStaleRuntimeKeys, prepareProductionEnvironment, serializePrivateEnvironment } from "./production-environment.ts";

const runtime = "postgres://monitrail_app.fixture:synthetic-password@aws-0-fixture.pooler.supabase.com:6543/postgres";
const admin = runtime.replace("monitrail_app.", "postgres.").replace("6543", "5432");
const oauth = {
  AUTH_GITHUB_ID: "synthetic-github-client", AUTH_GITHUB_SECRET: "synthetic-github-client-secret",
  AUTH_GOOGLE_ID: "synthetic-google-client", AUTH_GOOGLE_SECRET: "synthetic-google-client-secret",
  AUTH_SECRET: "development-key-must-not-be-copied", INTERNAL_HMAC_SECRET: "development-hmac-must-not-be-copied",
};
const options = { origin: "https://app.example.invalid", abuseContact: "abuse@example.invalid" };

describe("production environment preparation", () => {
  it("creates fresh keys and copies only explicit OAuth app credentials", () => {
    const result = prepareProductionEnvironment({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: admin }, options, oauth);
    expect(result.saved.AUTH_SECRET).not.toBe(oauth.AUTH_SECRET);
    expect(result.saved.INTERNAL_HMAC_SECRET).not.toBe(oauth.INTERNAL_HMAC_SECRET);
    expect(result.saved.AUTH_GITHUB_SECRET).toBe(oauth.AUTH_GITHUB_SECRET);
    expect(Buffer.from(result.saved.CHANNEL_ENC_KEY, "base64url")).toHaveLength(32);
    expect(result.saved.SIGNUP_MODE).toBe("invite");
    expect(result.runtime.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(result.runtime.DATABASE_URL).toBe(runtime);
    expect(result.runtime.APP_URL).toBe(options.origin);
  });
  it("preserves generated keys and already configured providers on retry", () => {
    const first = prepareProductionEnvironment({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: admin }, options, oauth);
    const second = prepareProductionEnvironment(first.saved, options, { ...oauth, AUTH_GITHUB_SECRET: "different" });
    expect(second.saved).toEqual(first.saved);
  });
  it("never uploads unknown variables, admin credentials or local CA paths", () => {
    const result = prepareProductionEnvironment({ DATABASE_URL: runtime, MIGRATION_DATABASE_URL: admin, PRIVATE_OPERATOR_VALUE: "never-upload", DATABASE_CA_FILE: ".certs/ca.crt" }, options, oauth);
    expect(result.runtime.PRIVATE_OPERATOR_VALUE).toBeUndefined();
    expect(result.runtime.DATABASE_CA_FILE).toBeUndefined();
    expect(result.saved.PRIVATE_OPERATOR_VALUE).toBe("never-upload");
  });
  it.each([
    { ...options, origin: "http://app.example.invalid" },
    { ...options, origin: "https://user:password@app.example.invalid" },
    { ...options, origin: "https://app.example.invalid/path" },
    { ...options, abuseContact: "invalid contact" },
  ])("rejects invalid public settings without echoing values", (settings) => {
    expect(() => prepareProductionEnvironment({ DATABASE_URL: runtime }, settings, oauth)).toThrow("Production settings are invalid.");
  });
  it("refuses administrative runtime roles, open signup and incomplete provider settings", () => {
    for (const saved of [{ DATABASE_URL: admin }, { DATABASE_URL: runtime, SIGNUP_MODE: "open" }]) {
      expect(() => prepareProductionEnvironment(saved, options, oauth)).toThrow("Production settings are invalid.");
    }
    expect(() => prepareProductionEnvironment({ DATABASE_URL: runtime }, options)).toThrow("Production settings are invalid.");
  });
  it("requires complete Telegram settings instead of copying a development bot", () => {
    const first = prepareProductionEnvironment({ DATABASE_URL: runtime }, options, { ...oauth, TELEGRAM_BOT_TOKEN: "not-copied" });
    expect(first.runtime.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(() => prepareProductionEnvironment({ ...first.saved, TELEGRAM_BOT_TOKEN: "partial" }, options)).toThrow("Production settings are invalid.");
  });
  it("generates a stable fresh webhook secret when a production bot identity is supplied", () => {
    const first = prepareProductionEnvironment({ DATABASE_URL: runtime, TELEGRAM_BOT_TOKEN: "12345:synthetic-bot-token", TELEGRAM_BOT_USERNAME: "fixture_bot" }, options, oauth);
    expect(first.runtime.TELEGRAM_WEBHOOK_SECRET).toHaveLength(43);
    expect(prepareProductionEnvironment(first.saved, options).runtime.TELEGRAM_WEBHOOK_SECRET).toBe(first.runtime.TELEGRAM_WEBHOOK_SECRET);
  });
  it("round-trips supported private values without altering quotes, backslashes or PEM newlines", () => {
    const values = { URL: runtime, SINGLE: "quote'here", DOUBLE: 'quote"here', BACKSLASH: "back\\slash", PEM: "first\nsecond\n", HASH: "literal # text" };
    expect(parseEnv(serializePrivateEnvironment(values))).toEqual(values);
  });
  it("refuses unsafe environment names and values instead of changing their meaning", () => {
    const invalidValues: Record<string, string>[] = [{ "INVALID=NAME": "value" }, { KEY: "nul\0value" }];
    for (const values of invalidValues) {
      expect(() => serializePrivateEnvironment(values)).toThrow("Production settings are invalid.");
    }
  });
  it("refuses stale optional or administrative variables left on a production project", () => {
    const desired = { APP_URL: options.origin, DATABASE_URL: runtime };
    expect(() => assertNoStaleRuntimeKeys([], desired)).not.toThrow();
    expect(() => assertNoStaleRuntimeKeys(["APP_URL", "DATABASE_URL"], desired)).not.toThrow();
    for (const stale of ["MIGRATION_DATABASE_URL", "DATABASE_CA_FILE", "TELEGRAM_BOT_TOKEN", "CHANNEL_ENC_PREVIOUS_KEY"]) {
      expect(() => assertNoStaleRuntimeKeys([stale], desired)).toThrow("Production settings are invalid.");
    }
  });
});
