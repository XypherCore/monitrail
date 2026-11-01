import { sql, type SQL } from "drizzle-orm";

type Executor = { execute(statement: SQL): PromiseLike<{ rows: unknown[] }> };

export const fixtureOwners = [
  { id: "d0000000-0000-4000-8000-000000000001", email: "demo-a@example.invalid", name: "Demo owner A", monitorId: "d1000000-0000-4000-8000-000000000001" },
  { id: "d0000000-0000-4000-8000-000000000002", email: "demo-b@example.invalid", name: "Demo owner B", monitorId: "d1000000-0000-4000-8000-000000000002" },
] as const;

// Administrative fixtures only; callers wrap the complete seed in a transaction.
// No channel, auth-session, OAuth-token or verification secrets are seeded.
export async function seedFixtures(db: Executor, now = new Date()): Promise<void> {
  for (const [position, owner] of fixtureOwners.entries()) {
    const userId = owner.id;
    const monitorId = owner.monitorId;
    const pageId = position === 0 ? "d2000000-0000-4000-8000-000000000001" : "d2000000-0000-4000-8000-000000000002";
    const incidentId = position === 0 ? "d3000000-0000-4000-8000-000000000001" : "d3000000-0000-4000-8000-000000000002";
    await db.execute(sql`INSERT INTO users(id,email,name) VALUES(${userId},${owner.email},${owner.name}) ON CONFLICT (id) DO NOTHING`);
    // A fixed fixture ID must never acquire another account's data.
    const identity = await db.execute(sql`SELECT id FROM users WHERE id=${userId} AND email=${owner.email}`);
    if (identity.rows.length !== 1) throw new Error("Fixture identity collision");
    await db.execute(sql`INSERT INTO monitors(id,user_id,name,url,status,is_paused,next_check_at,last_checked_at,created_at) VALUES(${monitorId},${userId},${`Demo site ${position + 1}`},${`https://demo-${position + 1}.example.invalid`},'paused',true,${now},${now},${now}) ON CONFLICT(id) DO NOTHING`);
    const existing = await db.execute(sql`SELECT created_at FROM monitors WHERE id=${monitorId} AND user_id=${userId}`);
    const row = existing.rows[0] as { created_at?: Date | string } | undefined;
    if (!row?.created_at) throw new Error("Fixture monitor collision");
    // Keep the first seed's clock so rerunning tomorrow cannot duplicate history.
    const anchor = new Date(row.created_at);
    await db.execute(sql`INSERT INTO status_pages(id,user_id,slug,title) VALUES(${pageId},${userId},${`demo-${position + 1}`},${`Demo status ${position + 1}`}) ON CONFLICT(id) DO NOTHING`);
    await db.execute(sql`INSERT INTO status_page_monitors(status_page_id,monitor_id,user_id) VALUES(${pageId},${monitorId},${userId}) ON CONFLICT DO NOTHING`);
    const start = new Date(anchor.getTime() - 3600_000);
    const end = new Date(start.getTime() + 900_000);
    await db.execute(sql`INSERT INTO incidents(id,monitor_id,user_id,started_at,resolved_at,cause) VALUES(${incidentId},${monitorId},${userId},${start},${end},'timeout') ON CONFLICT(id) DO NOTHING`);
    const incident = await db.execute(sql`SELECT id FROM incidents WHERE id=${incidentId} AND monitor_id=${monitorId} AND user_id=${userId}`);
    if (incident.rows.length !== 1) throw new Error("Fixture incident collision");
    for (let sample = 0; sample < 12; sample++) {
      const checkedAt = new Date(anchor.getTime() - (12 - sample) * 300_000);
      const ok = sample > 1;
      await db.execute(sql`INSERT INTO checks(monitor_id,checked_at,ok,status_code,response_ms,error_type)
        SELECT ${monitorId}::uuid,${checkedAt},${ok},${ok ? 200 : null}::integer,${ok ? 100 + sample * 5 : null}::integer,${ok ? null : "timeout"}::check_error
        WHERE NOT EXISTS (SELECT 1 FROM checks WHERE monitor_id=${monitorId} AND checked_at=${checkedAt})`);
    }
    await db.execute(sql`INSERT INTO check_rollups_hourly(monitor_id,hour,total,failed,avg_ms,p95_ms,max_ms)
      SELECT monitor_id,date_trunc('hour',checked_at),count(*)::integer,count(*) FILTER (WHERE NOT ok)::integer,
        avg(response_ms),percentile_cont(0.95) WITHIN GROUP (ORDER BY response_ms),max(response_ms)
      FROM checks WHERE monitor_id=${monitorId} GROUP BY monitor_id,date_trunc('hour',checked_at)
      ON CONFLICT(monitor_id,hour) DO NOTHING`);
  }
}
