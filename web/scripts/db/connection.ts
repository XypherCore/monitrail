import { Pool } from "@neondatabase/serverless";

// Administrative migration/fixture tooling only. The application DAL is Phase 2.
export function openNeonPool(): Pool {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("Configure DATABASE_URL for the disposable Neon branch.");
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("DATABASE_URL is not a valid PostgreSQL connection string."); }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname.toLowerCase().endsWith(".neon.tech")) {
    throw new Error("Use the disposable Neon branch connection string for this command.");
  }
  const pool = new Pool({ connectionString: value, max: 1, connectionTimeoutMillis: 10000 });
  pool.on("error", () => { console.error("Database connection failed."); });
  return pool;
}

export function reportDatabaseFailure(action: string): void {
  // Driver exceptions may contain connection URLs, query values and credentials.
  console.error(`${action} failed. Check the configured branch, privileges and migration state.`);
  process.exitCode = 1;
}
