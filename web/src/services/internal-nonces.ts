import { sql } from "drizzle-orm";
import {
  INTERNAL_NONCE_TTL_SECONDS,
  isInternalUuid,
} from "../../../shared/checks/signing.ts";
import type { DataExecutor } from "../data/access.ts";

/** Durable replay protection shared by all instances and both internal routes. */
export function createInternalNonceStore(db: DataExecutor) {
  return {
    async consume(nonce: string): Promise<boolean> {
      if (!isInternalUuid(nonce) || !db.transaction) {
        throw new Error("Internal replay protection is unavailable.");
      }
      const key = `nonce:${nonce}`;
      return db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text,0))`);
        const result = await tx.execute(sql`
          WITH stamp AS (SELECT clock_timestamp() AS at)
          INSERT INTO rate_limits(key,window_start,count)
          SELECT ${key},stamp.at,1 FROM stamp
          WHERE NOT EXISTS (
            SELECT 1 FROM rate_limits
            WHERE key=${key} AND window_start >= stamp.at -
              ${INTERNAL_NONCE_TTL_SECONDS}::double precision * interval '1 second'
          )
          ON CONFLICT DO NOTHING
          RETURNING key
        `);
        return result.rows.length === 1;
      }, { isolationLevel: "read committed" });
    },
  };
}
