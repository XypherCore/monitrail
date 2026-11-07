import { sql } from "drizzle-orm";
import type { DataExecutor } from "../../src/data/access.ts";
import { fixtureOwners } from "./fixtures.ts";

/** Only synthetic, paused data. A caller transaction makes the entire seed atomic. */
export async function seedRev2Fixtures(db: DataExecutor) {
  for (const [index, owner] of fixtureOwners.entries()) {
    await db.execute(sql`INSERT INTO users(id,email,name) VALUES (${owner.id},${owner.email},${owner.name})
      ON CONFLICT(id) DO NOTHING`);
    const identity = await db.execute(
      sql`SELECT id FROM users WHERE id=${owner.id} AND email=${owner.email}`,
    );
    if (identity.rows.length !== 1) throw new Error("Synthetic fixture identity collision.");
    const host = `demo-${index + 1}.example.invalid`;
    await db.execute(sql`INSERT INTO monitors(id,user_id,name,url,host,is_paused,pause_reason)
      VALUES (${owner.monitorId},${owner.id},${`Demo site ${index + 1}`},${`https://${host}/`},${host},true,'user')
      ON CONFLICT(id) DO NOTHING`);
    const monitor = await db.execute(sql`SELECT id FROM monitors WHERE id=${owner.monitorId}
      AND user_id=${owner.id} AND host=${host} AND is_paused=true`);
    if (monitor.rows.length !== 1) throw new Error("Synthetic fixture monitor collision.");
    const pageId = `d2000000-0000-4000-8000-00000000000${index + 1}`;
    const slug = `demo-${index + 1}`;
    await db.execute(sql`INSERT INTO status_pages(id,user_id,slug,title)
      VALUES (${pageId},${owner.id},${slug},${`Demo status ${index + 1}`})
      ON CONFLICT(id) DO NOTHING`);
    await db.execute(sql`INSERT INTO status_page_monitors(status_page_id,monitor_id,user_id)
      VALUES (${pageId},${owner.monitorId},${owner.id}) ON CONFLICT DO NOTHING`);
  }
}
