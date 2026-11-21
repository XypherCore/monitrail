import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ManagementRateError,
  reserveAccountDeletion,
  reserveManagementWrite,
} from "./management-rate.ts";

const owner = "a1000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const key = `management-write:${owner}`;
let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
  });
}, 30_000);

beforeEach(async () => {
  await client.exec("TRUNCATE users,rate_limits CASCADE");
  await client.query("INSERT INTO users(id,name) VALUES ($1,'Fixture'),($2,'Other fixture')", [owner, other]);
});

afterAll(async () => { await client?.close(); });

describe("authenticated management request budgets", () => {
  it("atomically admits only sixty simultaneous management attempts for one owner", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 64 }, () => reserveManagementWrite(db, owner)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(60);
    for (const result of results.filter((result) => result.status === "rejected")) {
      expect(result.reason).toBeInstanceOf(ManagementRateError);
      expect(result.reason.retryAfterSeconds).toBeGreaterThan(0);
      expect(result.reason.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
    expect((await client.query("SELECT sum(count)::int AS total FROM rate_limits WHERE key=$1", [key])).rows)
      .toEqual([{ total: 60 }]);
  });

  it("isolates owners and preserves the separate account deletion allowance", async () => {
    await client.query("INSERT INTO rate_limits(key,window_start,count) VALUES ($1,clock_timestamp(),60)", [key]);
    await expect(reserveManagementWrite(db, owner)).rejects.toBeInstanceOf(ManagementRateError);
    await expect(reserveManagementWrite(db, owner.toUpperCase())).rejects.toBeInstanceOf(ManagementRateError);
    await expect(reserveManagementWrite(db, other)).resolves.toBeUndefined();
    const attempts = await Promise.allSettled(Array.from({ length: 4 }, () => reserveAccountDeletion(db, owner)));
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    const [rejected] = attempts.filter((result) => result.status === "rejected");
    expect(rejected.reason).toBeInstanceOf(ManagementRateError);
    await expect(reserveAccountDeletion(db, other)).resolves.toBeUndefined();
  });

  it("keeps a reservation committed when a subsequent mutation fails", async () => {
    await expect((async () => {
      await reserveManagementWrite(db, owner);
      throw new Error("Synthetic mutation failure.");
    })()).rejects.toThrow("Synthetic mutation failure.");
    expect((await client.query("SELECT count FROM rate_limits WHERE key=$1", [key])).rows)
      .toEqual([{ count: 1 }]);
  });

  it("expires old usage while calculating a bounded Retry-After from the rolling window", async () => {
    await client.query("INSERT INTO rate_limits(key,window_start,count) VALUES ($1,clock_timestamp()-interval '2 hours',60)", [key]);
    await reserveManagementWrite(db, owner);
    expect((await client.query("SELECT sum(count)::int AS total FROM rate_limits WHERE key=$1", [key])).rows)
      .toEqual([{ total: 1 }]);
    await client.query("DELETE FROM rate_limits WHERE key=$1", [key]);
    await client.query("INSERT INTO rate_limits(key,window_start,count) VALUES ($1,clock_timestamp()-interval '30 minutes',60)", [key]);
    const error = await reserveManagementWrite(db, owner).catch((value) => value);
    expect(error).toBeInstanceOf(ManagementRateError);
    expect(error.retryAfterSeconds).toBeGreaterThan(1790);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(1800);
  });

  it("rejects malformed or missing owners before writing budget rows", async () => {
    const execute = vi.fn();
    await expect(reserveManagementWrite({ execute }, "invalid")).rejects.toThrow("Request budget is temporarily unavailable.");
    expect(execute).not.toHaveBeenCalled();
    await client.query("DELETE FROM users WHERE id=$1", [owner]);
    await expect(reserveManagementWrite(db, owner)).rejects.toThrow("Request budget is temporarily unavailable.");
    expect((await client.query("SELECT key FROM rate_limits")).rows).toEqual([]);
  });
});
