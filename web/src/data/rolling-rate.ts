import { sql } from "drizzle-orm";
import type { DataExecutor } from "./access.ts";

export const urlValidationRateKey = (ownerId: string) =>
	`monitor-url:${ownerId}`;

/** The caller holds the owner's transaction advisory lock for all requested keys. */
export async function reserveRollingLimits(
	tx: DataExecutor,
	limits: { key: string; limit: number }[],
	windowSeconds = 3600,
): Promise<number | null> {
	const values = sql.join(
		limits.map(({ key, limit }) => sql`(${key}::text,${limit}::int)`),
		sql`,`,
	);
	const { rows } = await tx.execute(sql`
    WITH requested(key,cap) AS (VALUES ${values}),
      stamp AS MATERIALIZED (
        SELECT clock_timestamp() AS at, ${windowSeconds}::double precision * interval '1 second' AS span
      ),
      limited AS MATERIALIZED (
        SELECT greatest(1,ceil(extract(epoch FROM min(r.window_start) + s.span - s.at)))::int AS retry
        FROM requested q CROSS JOIN stamp s
        JOIN rate_limits r ON r.key=q.key AND r.window_start > s.at-s.span
        GROUP BY q.key,q.cap,s.at,s.span HAVING sum(r.count) >= q.cap
      ),
      expired AS (
        DELETE FROM rate_limits r USING requested q,stamp s
        WHERE r.key=q.key AND r.window_start <= s.at-s.span
      ),
      reserved AS (
        INSERT INTO rate_limits(key,window_start,count)
        SELECT q.key,s.at,1 FROM requested q CROSS JOIN stamp s
        WHERE NOT EXISTS (SELECT 1 FROM limited)
        ON CONFLICT(key,window_start) DO UPDATE SET count=rate_limits.count+1
      )
    SELECT max(retry)::int AS retry FROM limited
  `);
	return (rows[0] as { retry: number | null }).retry;
}
