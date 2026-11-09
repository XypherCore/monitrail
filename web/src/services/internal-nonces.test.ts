import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createInternalNonceStore } from "./internal-nonces.ts";

const nonce = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

describe("PostgreSQL internal nonce storage", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
  }, 30_000);
  beforeEach(async () => {
    await client.exec("TRUNCATE rate_limits");
  });
  afterAll(async () => {
    await client?.close();
  });

  it("serializes a nonce across independent store instances", async () => {
    const first = createInternalNonceStore(db);
    const second = createInternalNonceStore(db);
    const outcomes = await Promise.all([first.consume(nonce), second.consume(nonce)]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await first.consume(other)).toBe(true);
    const result = await client.query<{ total: number }>("SELECT count(*)::int AS total FROM rate_limits");
    expect(result.rows[0]?.total).toBe(2);
  });

  it("refuses a nonce within the replay window and admits one older than the window", async () => {
    await client.query(
      "INSERT INTO rate_limits(key,window_start,count) VALUES ($1,clock_timestamp()-interval '119 seconds',1),($2,clock_timestamp()-interval '121 seconds',1)",
      [`nonce:${nonce}`, `nonce:${other}`],
    );
    const store = createInternalNonceStore(db);
    expect(await store.consume(nonce)).toBe(false);
    expect(await store.consume(other)).toBe(true);
    expect(await store.consume(other)).toBe(false);
  });

  it("rejects noncanonical nonce keys and unavailable transaction boundaries", async () => {
    await expect(createInternalNonceStore(db).consume("invalid")).rejects.toThrow();
    await expect(createInternalNonceStore({ execute: db.execute.bind(db) }).consume(nonce)).rejects.toThrow();
  });
});
