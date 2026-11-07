import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { postgresOptions, postgresProject, readPostgresUrl, readRuntimePostgresUrl } from "../../src/db/postgres-config.ts";
import { fixtureOwners } from "./fixtures.ts";
import { seedRev2Fixtures } from "./rev2-fixtures.ts";
import { postgresAccess } from "../../src/db/postgres-access.ts";
import { configureApplicationRole } from "./application-role.ts";

const action = process.argv[2];
const resume = action === "verify" && process.argv.includes("--resume-after-migration");
let client: ReturnType<typeof postgres> | undefined;
let stage = "configuration";
try {
  if (!["migrate", "seed", "verify"].includes(action) || process.env.NODE_ENV === "production")
    throw new Error();
  if (action === "verify" && !process.argv.includes("--confirm-clean-project")) throw new Error();
  if (action === "seed" && !process.argv.includes("--confirm-test-data")) throw new Error();
  const runtimeUrl = readPostgresUrl(process.env.DATABASE_URL);
  const adminUrl = readPostgresUrl(process.env.MIGRATION_DATABASE_URL);
  assert.equal(postgresProject(runtimeUrl), postgresProject(adminUrl));
  assert.equal(new URL(runtimeUrl).pathname, new URL(adminUrl).pathname);
  const options = postgresOptions();
  client = postgres(adminUrl, options);
  const db = drizzle(client);
  const access = postgresAccess(db);
  const migrationsFolder = fileURLToPath(new URL("../../drizzle-rev2", import.meta.url));
  if (action === "verify") {
    stage = "connection mode";
    const runtimeTarget = new URL(runtimeUrl);
    const adminTarget = new URL(adminUrl);
    assert(runtimeTarget.hostname.endsWith(".pooler.supabase.com"));
    assert.equal(runtimeTarget.port, "6543");
    assert(["", "5432"].includes(adminTarget.port));
    stage = "transaction pooler TLS preflight";
    const runtime = postgres(runtimeUrl, options);
    try {
      await runtime`SELECT 1`;
    } finally {
      await runtime.end({ timeout: 5 });
    }
    stage = resume ? "existing migration and synthetic fixtures" : "fresh application target";
    const existing = await db.execute(sql`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('users','accounts','sessions','invites','monitors',
      'checks','incidents','check_attempts','monitor_events','alert_channels','monitor_alert_channels',
      'alert_outbox','telegram_link_codes','status_pages','status_page_monitors','slug_tombstones',
      'rate_limits','system_heartbeat','blocked_hosts','verification','alert_events','check_rollups_hourly')`);
    if (resume) {
      const migrations = readMigrationFiles({ migrationsFolder });
      const applied = await client`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      assert.equal(existing.length, 19);
      assert.deepEqual(applied.map(row => [row.hash, Number(row.created_at)]), migrations.map(row => [row.hash, row.folderMillis]));
      const owners = await client`SELECT id,email FROM users ORDER BY id`;
      assert.deepEqual(owners.map(row => [row.id, row.email]), fixtureOwners.map(owner => [owner.id, owner.email]));
    } else {
      assert.equal(existing.length, 0);
    }
  }
  if (action !== "seed" && !resume) {
    stage = "committed clean-target migrations";
    await migrate(db, { migrationsFolder });
    await migrate(db, { migrationsFolder });
  }
  if (action !== "migrate") {
    stage = "atomic synthetic seed and replay";
    await access.transaction(seedRev2Fixtures);
    await access.transaction(seedRev2Fixtures);
  }
  if (action === "verify") {
    stage = "restricted application role";
    await configureApplicationRole(client);
    stage = "open incident uniqueness";
    const [owner] = fixtureOwners;
    await client.begin(async (transaction) => {
      const [probe] = await transaction`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause)
        VALUES (${owner.monitorId},${owner.id},now(),now(),'timeout') RETURNING id`;
      let uniqueRejected = false;
      try {
        await transaction.savepoint(async (savepoint) => {
          await savepoint`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause)
            VALUES (${owner.monitorId},${owner.id},now(),now(),'timeout')`;
        });
      } catch (error) {
        uniqueRejected =
          typeof error === "object" && error !== null && "code" in error && error.code === "23505";
      }
      assert(uniqueRejected);
      await transaction`DELETE FROM incidents WHERE id=${probe.id}`;
    });
    stage = "pooled runtime connection";
    const runtime = postgres(readRuntimePostgresUrl(process.env.DATABASE_URL), options);
    try {
      const [result] = await runtime`SELECT count(*)::int AS count FROM users
        WHERE id IN (${fixtureOwners[0].id},${fixtureOwners[1].id})`;
      assert.equal(result.count, 2);
      const [identity] = await runtime`SELECT current_user AS role`;
      assert.equal(identity.role, "monitrail_app");
      stage = "overlapping pooled queries";
      // Separate HTTP requests can share this connection even at max: 1.
      const owners = await Promise.all(fixtureOwners.map(async (owner) => {
        const [found] = await runtime`SELECT id FROM users WHERE id=${owner.id}::uuid`;
        return found?.id;
      }));
      assert.deepEqual(owners, fixtureOwners.map(owner => owner.id));
    } finally {
      await runtime.end({ timeout: 5 });
    }
  }
  console.log(`Rev 2 database ${action} passed. Only synthetic fixtures were seeded.`);
} catch (error) {
  let source: unknown = error;
  let code: unknown;
  for (let depth = 0; depth < 5 && source && typeof source === "object"; depth++) {
    if ("code" in source) code = source.code;
    source = "cause" in source ? source.cause : null;
  }
  const category = code === "28P01" ? "authentication" :
    code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ? "TLS certificate" :
    code === "ENETUNREACH" || code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "CONNECT_TIMEOUT" ? "network" :
    error instanceof assert.AssertionError ? "target verification" : "database";
  console.error(
    `Rev 2 database ${action ?? "command"} failed during ${stage} (${category}). Connection values and raw errors were suppressed.`,
  );
  if (typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)) console.error(`Database diagnostic code ${code}.`);
  process.exitCode = 1;
} finally {
  try {
    await client?.end({ timeout: 5 });
  } catch {
    process.exitCode = 1;
  }
}
