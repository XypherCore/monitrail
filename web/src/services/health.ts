import { sql } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";

// The documented Supabase Free database budget is 500 MB.
export const STORAGE_LIMIT_BYTES = 500_000_000;
const HEALTH_STORAGE_LIMIT_BYTES = STORAGE_LIMIT_BYTES * 0.9;
const HEARTBEAT_MAX_AGE_SECONDS = 180;

/** Read-only public capability. Database details stay inside the service. */
export async function readHealth(db: DataExecutor): Promise<boolean> {
  try {
    const { rows } = await db.execute(sql`
      SELECT extract(epoch FROM (clock_timestamp()-h.last_tick_at))::double precision AS "ageSeconds",
        pg_database_size(current_database())::double precision AS "storageBytes"
      FROM system_heartbeat h WHERE h.name='checker'
    `);
    const row = rows[0] as { ageSeconds?: unknown; storageBytes?: unknown } | undefined;
    const age = row?.ageSeconds;
    const bytes = row?.storageBytes;
    return typeof age === "number" && Number.isFinite(age) &&
      age >= 0 && age < HEARTBEAT_MAX_AGE_SECONDS &&
      typeof bytes === "number" && Number.isSafeInteger(bytes) &&
      bytes >= 0 && bytes < HEALTH_STORAGE_LIMIT_BYTES;
  } catch {
    return false;
  }
}

export function createHealthHandler(check: () => Promise<boolean>) {
  return async (): Promise<Response> => {
    let healthy = false;
    try { healthy = await check(); }
    catch { /* A failed health read is an unavailable service. */ }
    return new Response(null, {
      status: healthy ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  };
}
