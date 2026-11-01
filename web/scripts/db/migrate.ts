import { openNeonPool, reportDatabaseFailure } from "./connection.ts";
import { applyMigrationsWithKit } from "./migration-command.ts";

try {
  // Validate the destination without initiating any application access layer.
  const pool = openNeonPool();
  try { await pool.query("SELECT 1"); }
  finally { await pool.end(); }
  await applyMigrationsWithKit();
  console.log("Committed database migrations applied successfully.");
} catch {
  reportDatabaseFailure("Database migration");
}
