import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthRateLimitStorage, oauthSignInRateKey } from "./rate-limit.ts";

const secret = "synthetic-rate-limit-secret-for-tests-only";
const rawKey = "192.0.2.18|/sign-in/social";
const rule = { window: 10, max: 3 };

describe("OAuth client IP trust boundary", () => {
  const hosted = {
    NODE_ENV: "production",
    VERCEL: "1",
    VERCEL_REGION: "test1",
    VERCEL_ENV: "preview",
  };
  const anonymous = "anonymous|/sign-in/social";

  it("ignores every IP header outside a hosted Vercel runtime", () => {
    const headers = new Headers({
      "x-forwarded-for": "192.0.2.19",
      "x-real-ip": "192.0.2.20",
      "x-vercel-forwarded-for": "192.0.2.18",
    });
    for (const env of [
      {},
      { ...hosted, VERCEL: undefined },
      { ...hosted, VERCEL_REGION: undefined },
      { ...hosted, VERCEL_ENV: "development" },
      { ...hosted, NODE_ENV: "development" },
    ]) {
      expect(oauthSignInRateKey(headers, env)).toBe(anonymous);
    }
  });

  it("uses only the platform-owned single client IP on Vercel", () => {
    const headers = new Headers({
      "x-forwarded-for": "192.0.2.19",
      "x-real-ip": "192.0.2.20",
      "x-vercel-forwarded-for": "192.0.2.18",
    });
    expect(oauthSignInRateKey(headers, hosted)).toBe(rawKey);
    headers.set("x-forwarded-for", "192.0.2.21, 192.0.2.22");
    headers.set("x-real-ip", "192.0.2.23");
    expect(oauthSignInRateKey(headers, hosted)).toBe(rawKey);
    headers.delete("x-vercel-forwarded-for");
    expect(oauthSignInRateKey(headers, hosted)).toBe(anonymous);
  });

  it("rejects spoofed lists and normalizes literal IPs to a single bucket", () => {
    const headers = new Headers();
    for (const malformed of ["192.0.2.19, 192.0.2.18", "192.0.2.18:443", "fe80::1%eth0"]) {
      headers.set("x-vercel-forwarded-for", malformed);
      expect(oauthSignInRateKey(headers, hosted)).toBe(anonymous);
    }
    headers.set("x-vercel-forwarded-for", "::ffff:192.0.2.18");
    expect(oauthSignInRateKey(headers, hosted)).toBe(rawKey);
    headers.set("x-vercel-forwarded-for", "2001:0DB8:0000::2");
    expect(oauthSignInRateKey(headers, hosted)).toBe("[2001:db8::2]|/sign-in/social");
  });
});

describe("durable authentication admission and single-use OAuth state", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
    });
  }, 30000);
  beforeEach(async () => {
    await client.exec("TRUNCATE rate_limits");
  });
  afterAll(async () => {
    await client.close();
  });

  it("preserves the prior three-per-ten-second admission rule across instances", async () => {
    for (let i = 0; i < 3; i++) {
      expect(await createAuthRateLimitStorage(db, secret).consume(rawKey, rule)).toEqual({
        allowed: true,
        retryAfter: null,
      });
    }
    const denied = await createAuthRateLimitStorage(db, secret).consume(rawKey, rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(10);
  });

  it("atomically admits only the maximum across concurrent instances", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () =>
        createAuthRateLimitStorage(db, secret).consume(rawKey, rule),
      ),
    );
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(3);
    expect((await client.query("SELECT count FROM rate_limits")).rows).toEqual([{ count: 3 }]);
  });

  it("resets an expired idle window and denied requests never extend it", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    for (let i = 0; i < 3; i++) await storage.consume(rawKey, rule);
    const before = (await client.query("SELECT window_start FROM rate_limits")).rows;
    expect((await storage.consume(rawKey, rule)).allowed).toBe(false);
    expect((await client.query("SELECT window_start FROM rate_limits")).rows).toEqual(before);
    await client.exec("UPDATE rate_limits SET window_start=now()-interval '11 seconds'");
    expect((await storage.consume(rawKey, rule)).allowed).toBe(true);
    expect((await client.query("SELECT count FROM rate_limits")).rows).toEqual([{ count: 1 }]);
  });

  it("stores only hashed namespaced identities and separates keys and secrets", async () => {
    await createAuthRateLimitStorage(db, secret).consume(rawKey, rule);
    await createAuthRateLimitStorage(db, secret).consume("192.0.2.19|/sign-in/social", rule);
    await createAuthRateLimitStorage(db, `${secret}-other`).consume(rawKey, rule);
    const rows = (await client.query<{ key: string }>("SELECT key FROM rate_limits")).rows;
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => /^auth-rate:[a-f0-9]{64}$/.test(row.key))).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("192.0.2.18");
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("consumes an OAuth state exactly once and rejects expired or unknown states", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    const state = "a".repeat(64);
    await storage.reserveOAuthState(state);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => storage.consumeOAuthState(state)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storage.consumeOAuthState("b".repeat(64))).toBe(false);
    await storage.reserveOAuthState("c".repeat(64));
    await client.exec("UPDATE rate_limits SET window_start=now()-interval '16 minutes'");
    expect(await storage.consumeOAuthState("c".repeat(64))).toBe(false);
  });

  it("rejects bad inputs and hides driver details", async () => {
    expect(() => createAuthRateLimitStorage(db, "short")).toThrow(
      "Authentication rate limit unavailable.",
    );
    const storage = createAuthRateLimitStorage(db, secret);
    await expect(storage.consume("", rule)).rejects.toThrow(
      "Authentication rate limit unavailable.",
    );
    await expect(storage.consume(rawKey, { max: 0, window: 10 })).rejects.toThrow(
      "Authentication rate limit unavailable.",
    );
    await expect(storage.reserveOAuthState("bad")).rejects.toThrow(
      "Authentication rate limit unavailable.",
    );
    const broken = createAuthRateLimitStorage(
      {
        execute() {
          throw new Error("fixture credential detail");
        },
        async transaction() {
          throw new Error("fixture credential detail");
        },
      },
      secret,
    );
    await expect(broken.consume(rawKey, rule)).rejects.toThrow(
      "Authentication rate limit unavailable.",
    );
  });
});
