import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/neon-serverless";
import { sql } from "drizzle-orm";
import { openNeonPool, reportDatabaseFailure } from "./connection.ts";
import { fixtureOwners, seedFixtures } from "./fixtures.ts";
import { applyMigrationsWithKit } from "./migration-command.ts";

function timestampMs(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

async function verify(): Promise<void> {
  if (!process.argv.includes("--confirm-clean-branch") || process.env.NODE_ENV === "production") {
    throw new Error("Verification requires an explicitly confirmed disposable clean branch.");
  }
  const pool = openNeonPool();
  try {
    const before = await pool.query<{ total: number }>("SELECT count(*)::integer AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
    if (before.rows[0]?.total !== 0) throw new Error("A clean public schema is required.");
    await applyMigrationsWithKit();
    // A second application must be a no-op, not a duplicate schema migration.
    await applyMigrationsWithKit();
    const after = await pool.query<{ total: number }>("SELECT count(*)::integer AS total FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
    if (after.rows[0]?.total !== 14) throw new Error("Unexpected schema table count.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const userId = randomUUID();
      const monitorId = randomUUID();
      const incidentId = randomUUID();
      await client.query("INSERT INTO users(id,email,name) VALUES($1,$2,'Temporary verification fixture')", [userId, `${userId}@example.invalid`]);
      await client.query("INSERT INTO monitors(id,user_id,name,url) VALUES($1,$2,'Temporary fixture','https://fixture.example.invalid')", [monitorId, userId]);
      await client.query("INSERT INTO incidents(id,monitor_id,user_id,started_at,cause) VALUES($1,$2,$3,now(),'timeout')", [incidentId, monitorId, userId]);
      await client.query("SAVEPOINT duplicate_incident");
      let rejected = false;
      try {
        await client.query("INSERT INTO incidents(monitor_id,user_id,started_at,cause) VALUES($1,$2,now(),'dns')", [monitorId, userId]);
      } catch (error) {
        rejected = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
      }
      await client.query("ROLLBACK TO SAVEPOINT duplicate_incident");
      if (!rejected) throw new Error("Second open incident was not rejected by the unique index.");
      await client.query("UPDATE incidents SET resolved_at=now() WHERE id=$1 AND user_id=$2", [incidentId, userId]);
      await client.query("INSERT INTO incidents(monitor_id,user_id,started_at,cause) VALUES($1,$2,now(),'dns')", [monitorId, userId]);
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
    const db = drizzle(pool);
    await db.transaction(tx => seedFixtures(tx));
    await db.transaction(tx => seedFixtures(tx));
    const counts = await db.execute(sql`SELECT (SELECT count(*) FROM users)::integer AS users, (SELECT count(*) FROM checks)::integer AS checks, (SELECT count(*) FROM monitors WHERE NOT is_paused)::integer AS active`);
    if (counts.rows[0]?.users !== 2 || counts.rows[0]?.checks !== 24 || counts.rows[0]?.active !== 0) {
      throw new Error("Seed verification failed.");
    }
    console.log("Neon verification passed: clean migration, migration replay, unique open-incident rejection, resolved-incident reopening, and idempotent fake seed.");
  } finally {
    await pool.end();
  }
}

async function verifyExistingFixtures(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Development fixtures only.");
  const pool = openNeonPool();
  try {
    await drizzle(pool).transaction(async tx => {
      const users = await tx.execute(sql`SELECT id,email FROM users`);
      if (users.rows.length !== 2 || users.rows.some(row => !fixtureOwners.some(owner => owner.id === row.id && owner.email === row.email))) {
        throw new Error("Unrelated users; refusing fixture adjustment.");
      }
      const counts = await tx.execute(sql`SELECT (SELECT count(*) FROM monitors)::integer AS monitors,(SELECT count(*) FROM checks)::integer AS checks,(SELECT count(*) FROM alert_channels)::integer AS channels`);
      if (counts.rows[0]?.monitors !== 2 || counts.rows[0]?.checks !== 24 || counts.rows[0]?.channels !== 0) {
        throw new Error("Unexpected fixture data; refusing adjustment.");
      }
      const monitors = await tx.execute(sql`SELECT m.id,m.user_id,m.url,m.is_paused,m.last_checked_at,(SELECT max(c.checked_at)+interval '5 minutes' FROM checks c WHERE c.monitor_id=m.id) AS expected_anchor FROM monitors m`);
      for (const row of monitors.rows) {
        const expected = fixtureOwners.find(owner => owner.id === row.user_id && owner.monitorId === row.id);
        if (!expected || !row.is_paused || !String(row.url).endsWith(".example.invalid") ||
          timestampMs(row.last_checked_at) !== timestampMs(row.expected_anchor)) {
          throw new Error("Fixture was edited; refusing adjustment.");
        }
        // Normalize only this Phase 1 run's synthetic, pre-review seed anchors.
        await tx.execute(sql`UPDATE monitors SET created_at=last_checked_at WHERE id=${row.id} AND user_id=${row.user_id}`);
      }
      await seedFixtures(tx);
      await tx.execute(sql`SAVEPOINT seed_clock_regression`);
      await tx.execute(sql`UPDATE monitors SET last_checked_at=last_checked_at+interval '1 day' WHERE user_id IN (${fixtureOwners[0].id},${fixtureOwners[1].id})`);
      await seedFixtures(tx, new Date(Date.now() + 86400_000));
      const after = await tx.execute(sql`SELECT count(*)::integer AS checks FROM checks`);
      if (after.rows[0]?.checks !== 24) throw new Error("Seed duplicated history.");
      await tx.execute(sql`ROLLBACK TO SAVEPOINT seed_clock_regression`);
    });
    console.log("Live seed verification passed: only synthetic fixture anchors normalized; changed last-check time did not duplicate the 24 checks; regression-only edits rolled back.");
  } finally {
    await pool.end();
  }
}

try {
  if (process.argv.includes("--confirm-existing-fixtures")) {
    if (process.argv.includes("--confirm-clean-branch")) throw new Error("Choose one verification mode.");
    await verifyExistingFixtures();
  } else {
    await verify();
  }
} catch { reportDatabaseFailure("Neon verification"); }
