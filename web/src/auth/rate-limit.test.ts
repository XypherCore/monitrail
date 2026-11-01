import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAuthRateLimitStorage } from "./rate-limit.ts";

const secret = "synthetic-rate-limit-secret-for-tests-only";
const rawKey = "192.0.2.18|/sign-in/social";
const rule = { window: 10, max: 3 };

describe("durable atomic pre-authentication rate limit", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  }, 30_000);
  beforeEach(async () => { await client.exec("TRUNCATE users, verification CASCADE"); });
  afterAll(async () => { await client?.close(); });

  it("uses the framework consume contract and denies beyond its supplied maximum", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    expect(Object.keys(storage)).toEqual(["consume"]);
    for (let i = 0; i < rule.max; i++) expect(await storage.consume(rawKey, rule)).toEqual({ allowed: true, retryAfter: null });
    const denied = await storage.consume(rawKey, rule);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    expect(denied.retryAfter).toBeLessThanOrEqual(rule.window);
    const stored = await client.query<{ count: number }>("SELECT (value::jsonb->>'count')::int AS count FROM verification");
    expect(stored.rows).toEqual([{ count: rule.max }]);
  });

  it("atomically admits only the maximum across concurrent storage instances", async () => {
    const decisions = await Promise.all(Array.from({ length: 40 }, () => createAuthRateLimitStorage(db, secret).consume(rawKey, rule)));
    expect(decisions.filter(decision => decision.allowed)).toHaveLength(rule.max);
    expect(decisions.filter(decision => !decision.allowed)).toHaveLength(40 - rule.max);
    expect((await client.query("SELECT id FROM verification")).rows).toHaveLength(1);
  });

  it("retains counters when the application creates a fresh storage instance", async () => {
    await createAuthRateLimitStorage(db, secret).consume(rawKey, rule);
    await createAuthRateLimitStorage(db, secret).consume(rawKey, rule);
    await createAuthRateLimitStorage(db, secret).consume(rawKey, rule);
    expect((await createAuthRateLimitStorage(db, secret).consume(rawKey, rule)).allowed).toBe(false);
  });

  it("resets an expired bucket using database expiry", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    for (let i = 0; i < rule.max; i++) await storage.consume(rawKey, rule);
    await client.exec("UPDATE verification SET expires_at=clock_timestamp()-interval '1 second'");
    expect(await storage.consume(rawKey, rule)).toEqual({ allowed: true, retryAfter: null });
    const state = await client.query<{ count: number; seconds: number }>("SELECT (value::jsonb->>'count')::int AS count,extract(epoch FROM expires_at-clock_timestamp())::float8 AS seconds FROM verification");
    expect(state.rows[0]?.count).toBe(1);
    expect(state.rows[0]?.seconds).toBeGreaterThan(0);
    expect(state.rows[0]?.seconds).toBeLessThanOrEqual(rule.window);
  });

  it("does not let denied requests keep extending the lockout", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    for (let i = 0; i < rule.max; i++) await storage.consume(rawKey, rule);
    const before = await client.query("SELECT expires_at FROM verification");
    expect((await storage.consume(rawKey, rule)).allowed).toBe(false);
    expect((await client.query("SELECT expires_at FROM verification")).rows).toEqual(before.rows);
  });

  it("persists only domain-separated HMAC identifiers and counters, never raw IPs or secrets", async () => {
    await createAuthRateLimitStorage(db, secret).consume(rawKey, rule);
    const rows = (await client.query<{ id: string; identifier: string; value: string; user_id: string | null }>("SELECT id,identifier,value,user_id FROM verification")).rows;
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(rows[0]?.identifier).toMatch(/^auth-rate:[0-9a-f]{64}$/);
    expect(rows[0]?.user_id).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("192.0.2.18");
    expect(JSON.stringify(rows)).not.toContain("/sign-in/social");
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it("keeps distinct identities, paths and secrets in separate buckets", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    for (let i = 0; i < rule.max; i++) await storage.consume(rawKey, rule);
    expect((await storage.consume("192.0.2.19|/sign-in/social", rule)).allowed).toBe(true);
    expect((await storage.consume("192.0.2.18|/get-session", rule)).allowed).toBe(true);
    expect((await createAuthRateLimitStorage(db, `${secret}-rotated`).consume(rawKey, rule)).allowed).toBe(true);
    expect((await client.query("SELECT id FROM verification")).rows).toHaveLength(4);
  });

  it("cleans only expired anonymous records in its exact rate-limit namespace", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    await storage.consume(rawKey, rule);
    await client.exec("UPDATE verification SET expires_at=clock_timestamp()-interval '1 second'");
    await client.exec("INSERT INTO users(id,email,name) VALUES('10000000-0000-4000-8000-000000000001','fixture@example.invalid','Fixture')");
    await client.exec("INSERT INTO verification(identifier,value,expires_at) VALUES('oauth-state-fixture','do-not-delete',clock_timestamp()-interval '1 minute'),('auth-rate:not-a-digest','do-not-delete',clock_timestamp()-interval '1 minute')");
    await client.exec("INSERT INTO verification(user_id,identifier,value,expires_at) VALUES('10000000-0000-4000-8000-000000000001','auth-rate:' || repeat('a',64),'do-not-delete',clock_timestamp()-interval '1 minute')");
    await storage.consume("192.0.2.20|/sign-in/social", rule);
    const all = await client.query<{ identifier: string }>("SELECT identifier FROM verification ORDER BY identifier");
    expect(all.rows).toHaveLength(4);
    expect(all.rows.some(row => row.identifier === "oauth-state-fixture")).toBe(true);
    expect(all.rows.some(row => row.identifier === "auth-rate:not-a-digest")).toBe(true);
    expect(all.rows.some(row => row.identifier === `auth-rate:${"a".repeat(64)}`)).toBe(true);
  });

  it("cannot overwrite a non-rate record even if its UUID collides", async () => {
    const storage = createAuthRateLimitStorage(db, secret);
    await storage.consume(rawKey, rule);
    await client.exec("UPDATE verification SET identifier='oauth-state-fixture',value='preserve-this-state'");
    await expect(storage.consume(rawKey, rule)).rejects.toThrow("Authentication rate limit unavailable.");
    expect((await client.query("SELECT identifier,value FROM verification")).rows).toEqual([{ identifier: "oauth-state-fixture", value: "preserve-this-state" }]);
  });

  it("validates rule/configuration inputs and fails closed without leaking dependency exceptions", async () => {
    expect(() => createAuthRateLimitStorage(db, "short")).toThrow("Authentication rate limit unavailable.");
    const storage = createAuthRateLimitStorage(db, secret);
    await expect(storage.consume("", rule)).rejects.toThrow("Authentication rate limit unavailable.");
    await expect(storage.consume(rawKey, { max: 0, window: 10 })).rejects.toThrow("Authentication rate limit unavailable.");
    await expect(storage.consume(rawKey, { max: 3, window: -10 })).rejects.toThrow("Authentication rate limit unavailable.");
    const unavailable = createAuthRateLimitStorage({ execute: async () => { throw new Error("postgresql://fixture:do-not-print@private.example.invalid/db"); } }, secret);
    try { await unavailable.consume(rawKey, rule); throw new Error("Expected database failure."); }
    catch (error) {
      expect(String(error)).toBe("Error: Authentication rate limit unavailable.");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
