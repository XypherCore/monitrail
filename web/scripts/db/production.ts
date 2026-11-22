import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, chmod } from "node:fs/promises";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { sql, type SQL } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { postgresOptions, postgresProject, readPostgresUrl, readRuntimePostgresUrl } from "../../src/db/postgres-config.ts";
import { applicationTables, configureApplicationRole } from "./application-role.ts";

type Migration = { hash: string; folderMillis: number };
type Snapshot = {
  tables: string[];
  applied: { hash: string; createdAt: number }[];
  counts: { table: string; count: number }[];
};
type Environment = Readonly<Record<string, string | undefined>>;
const environmentFile = new URL("../../.env.production.local", import.meta.url);
const migrationsFolder = fileURLToPath(new URL("../../drizzle-rev2", import.meta.url));

/** Only the approved fresh production project can enter the bootstrap. */
export function readProductionSetup(env: Environment, args: readonly string[]) {
  try {
    if (!args.includes("--confirm-fresh-production-project") || new Set(args).size !== args.length ||
      args.some((value) => !["--confirm-fresh-production-project", "--resume-after-migration"].includes(value))) throw new Error();
    const resume = args.includes("--resume-after-migration");
    const runtimeUrl = readPostgresUrl(env.DATABASE_URL);
    const adminUrl = readPostgresUrl(env.MIGRATION_DATABASE_URL);
    const runtime = new URL(runtimeUrl);
    const admin = new URL(adminUrl);
    const project = postgresProject(runtimeUrl);
    if (project !== postgresProject(adminUrl) || runtime.pathname !== admin.pathname || runtime.pathname !== "/postgres" ||
      !runtime.hostname.endsWith(".pooler.supabase.com") || runtime.port !== "6543" ||
      !["", "5432"].includes(admin.port) ||
      ![ `postgres.${project}`, ...(resume ? [`monitrail_app.${project}`] : []) ].includes(decodeURIComponent(runtime.username)) ||
      decodeURIComponent(admin.username) !== (admin.hostname.endsWith(".pooler.supabase.com") ? `postgres.${project}` : "postgres")) throw new Error();
    return { runtimeUrl, adminUrl, resume };
  } catch {
    throw new Error("Production database configuration is invalid.");
  }
}

/** Refuse unknown schema, altered migrations, seeded fixtures and live data. */
export function assertEmptyProductionSnapshot(
  snapshot: Snapshot,
  resume: boolean,
  expected: readonly Migration[],
  tables: readonly string[] = applicationTables,
): void {
  const invalid = () => new Error("Production target verification failed.");
  if (!resume) {
    if (snapshot.tables.length || snapshot.applied.length || snapshot.counts.length) throw invalid();
    return;
  }
  if (!expected.length ||
    JSON.stringify([...snapshot.tables].sort()) !== JSON.stringify([...tables].sort()) ||
    JSON.stringify(snapshot.applied) !== JSON.stringify(expected.map((migration) => ({ hash: migration.hash, createdAt: migration.folderMillis }))) ||
    snapshot.counts.length !== tables.length ||
    new Set(snapshot.counts.map((row) => row.table)).size !== tables.length ||
    snapshot.counts.some((row) => !tables.includes(row.table) || row.count !== 0)) throw invalid();
}

async function snapshot(query: { execute(statement: SQL): PromiseLike<unknown[]> }): Promise<Snapshot> {
  const relations = await query.execute(sql`SELECT table_name FROM information_schema.tables
    WHERE table_schema='public' ORDER BY table_name`) as { table_name: string }[];
  const tables = relations.map((row) => String(row.table_name));
  const [{ present }] = await query.execute(sql`SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`) as { present: boolean }[];
  const applied = present ? await query.execute(sql`SELECT hash,created_at FROM drizzle.__drizzle_migrations ORDER BY id`) as { hash: string; created_at: string }[] : [];
  const counts: Snapshot["counts"] = [];
  for (const table of applicationTables) {
    if (!tables.includes(table)) continue;
    const [{ count }] = await query.execute(sql`SELECT count(*)::int AS count FROM public.${sql.identifier(table)}`) as { count: number }[];
    counts.push({ table, count });
  }
  return { tables, applied: applied.map((row) => ({ hash: String(row.hash), createdAt: Number(row.created_at) })), counts };
}

export async function prepareProductionMigrations(client: postgres.Sql, resume: boolean): Promise<void> {
  const expected = readMigrationFiles({ migrationsFolder });
  await drizzle(client).transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await transaction.execute(sql`SET LOCAL statement_timeout = '60s'`);
    const [{ acquired }] = await transaction.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended('monitrail:production-bootstrap',0)) AS acquired`);
    if (acquired !== true) throw new Error("Production bootstrap is already running.");
    assertEmptyProductionSnapshot(await snapshot(transaction), resume, expected);
    if (!resume) {
      const roles = await transaction.execute(sql`SELECT 1 FROM pg_roles WHERE rolname='monitrail_app'`);
      if (roles.length) throw new Error("Production target verification failed.");
      // The pinned migrator uses the database's dialect/session interface,
      // also provided by a Drizzle transaction. Its nested work is a savepoint.
      await migrate(transaction as unknown as PostgresJsDatabase, { migrationsFolder });
    }
    assertEmptyProductionSnapshot(await snapshot(transaction), true, expected);
  });
}

async function verifyRuntime(client: postgres.Sql): Promise<void> {
  const [{ role, count }] = await client`SELECT current_user AS role, (SELECT count(*)::int FROM public.users) AS count`;
  if (role !== "monitrail_app" || count !== 0) throw new Error("Production runtime verification failed.");
  await client.begin(async (transaction) => {
    let refused = false;
    try {
      await transaction.savepoint(async (probe) => {
        await probe`CREATE TABLE public.monitrail_bootstrap_privilege_probe (id integer)`;
        // Roll back even if an unexpectedly privileged role created the table.
        throw new Error("Unexpected runtime privileges.");
      });
    } catch (error) {
      refused = typeof error === "object" && error !== null && "code" in error && error.code === "42501";
    }
    if (!refused) throw new Error("Production runtime verification failed.");
  });
}

/** Administrative entry point. It never seeds users or application fixtures. */
export async function bootstrapProduction(args: readonly string[]): Promise<void> {
  const env = process.env;
  const setup = readProductionSetup(env, args);
  const content = await readFile(environmentFile, "utf8");
  const saved = parseEnv(content);
  if ((content.match(/^DATABASE_URL=/gm) ?? []).length !== 1 ||
    (content.match(/^MIGRATION_DATABASE_URL=/gm) ?? []).length !== 1 ||
    readPostgresUrl(saved.DATABASE_URL) !== setup.runtimeUrl ||
    readPostgresUrl(saved.MIGRATION_DATABASE_URL) !== setup.adminUrl) throw new Error("Production environment entries are ambiguous.");
  await chmod(environmentFile, 0o600);
  const options = postgresOptions();
  const admin = postgres(setup.adminUrl, options);
  let runtime: postgres.Sql | undefined;
  try {
    // Check the transaction-pooler credential and TLS before any mutation.
    runtime = postgres(setup.runtimeUrl, options);
    await runtime`SELECT 1`;
    await runtime.end({ timeout: 5 });
    runtime = undefined;
    await prepareProductionMigrations(admin, setup.resume);
    await configureApplicationRole(admin, environmentFile);
    runtime = postgres(readRuntimePostgresUrl(env.DATABASE_URL), options);
    await verifyRuntime(runtime);
  } finally {
    await Promise.all([runtime?.end({ timeout: 5 }), admin.end({ timeout: 5 })]);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await bootstrapProduction(process.argv.slice(2));
    console.log("Production database preparation passed. No application data was seeded.");
  } catch {
    console.error("Production database preparation failed. Verify the target, TLS, credentials and saved migration state privately. No connection values or raw errors were displayed.");
    process.exitCode = 1;
  }
}
