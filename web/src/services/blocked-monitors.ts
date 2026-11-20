import { sql, type SQL } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";

export type BlockedMonitor = { id: string; host: string; configRev: number };

/** Apply the blocked lifecycle only to the configuration that was checked. */
export async function pauseBlockedMonitors(tx: DataExecutor, targets: BlockedMonitor[], now: SQL) {
  if (!targets.length) return [];
  const result = await tx.execute(sql`
    WITH locked AS (
      SELECT m.id,m.lease_id FROM monitors m
      JOIN jsonb_to_recordset(${JSON.stringify(targets)}::jsonb)
        AS target(id uuid,host text,"configRev" int)
        ON m.id=target.id AND m.host=target.host AND m.config_rev=target."configRev"
      WHERE m.pause_reason IS DISTINCT FROM 'blocked_host'
      ORDER BY m.id FOR UPDATE OF m SKIP LOCKED
    ), paused AS (
      UPDATE monitors m SET is_paused=true,pause_reason='blocked_host',
        config_rev=m.config_rev+1,lease_id=NULL,lease_until=NULL,
        failures=0,successes=0,streak_started_at=NULL,streak_first_error=NULL
      FROM locked WHERE m.id=locked.id
      RETURNING m.id,m.user_id,locked.lease_id AS previous_lease_id
    ), terminal AS (
      UPDATE check_attempts a SET state=CASE WHEN a.expires_at<=${now} THEN 'expired' ELSE 'dropped' END,
        terminal_at=greatest(${now},a.claimed_at)
      FROM paused p WHERE a.attempt_id=p.previous_lease_id AND a.monitor_id=p.id AND a.state='claimed'
    ), closed AS (
      UPDATE incidents i SET resolved_at=greatest(${now},i.started_at),resolved_reason='blocked'
      FROM paused p WHERE i.monitor_id=p.id AND i.user_id=p.user_id AND i.resolved_at IS NULL
    ), events AS (
      INSERT INTO monitor_events(monitor_id,kind,at) SELECT id,'blocked',${now} FROM paused
    )
    SELECT p.id,s.slug FROM paused p
    LEFT JOIN status_page_monitors l ON l.monitor_id=p.id AND l.user_id=p.user_id
    LEFT JOIN status_pages s ON s.id=l.status_page_id AND s.user_id=l.user_id
  `);
  return result.rows as { id: string; slug: string | null }[];
}
