import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { expect, it } from "vitest";
import { seedRev2Fixtures } from "../../scripts/db/rev2-fixtures.ts";

it("seeds only paused synthetic monitors, is idempotent and leaves auth secrets absent", async () => {
  const client = new PGlite();
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
    await db.transaction(seedRev2Fixtures);
    await db.transaction(seedRev2Fixtures);
    expect((await client.query("SELECT id FROM users")).rows).toHaveLength(2);
    expect((await client.query("SELECT id FROM monitors WHERE is_paused AND pause_reason='user'")).rows).toHaveLength(2);
    for (const table of ["sessions", "accounts", "invites", "alert_channels"]) {
      expect((await client.query(`SELECT * FROM ${table}`)).rows).toHaveLength(0);
    }
  } finally { await client.close(); }
}, 30000);
