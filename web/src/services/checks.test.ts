import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCheckCapabilities } from "./checks.ts";

const owner = "a1000000-0000-4000-8000-000000000001";
const batch = { max: 15 } as const;
let client: PGlite;
let checks: ReturnType<typeof createCheckCapabilities>;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
  checks = createCheckCapabilities(db);
}, 30_000);
beforeEach(async () => {
  await client.exec("TRUNCATE users,blocked_hosts,system_heartbeat CASCADE");
  await client.query("INSERT INTO users(id,name) VALUES ($1,'Fixture')", [owner]);
});
afterAll(async () => {
  await client?.close();
});

async function seed(host: string, delaySeconds = -20, paused = false): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO monitors (id,user_id,name,url,host,next_check_at,is_paused,pause_reason,expected_status)
     VALUES ($1,$2,'Fixture',$3,$4,clock_timestamp()+$5::double precision*interval '1 second',$6,$7,'2xx_3xx')`,
    [id, owner, `https://${host}/path?key=synthetic`, host, delaySeconds, paused, paused ? "user" : null],
  );
  return id;
}

describe("checker claim", () => {
  it("claims up to 15 due monitors in schedule order and snapshots the active lease", async () => {
    const first = await seed("first.example.invalid", -300);
    for (let index = 0; index < 15; index++) await seed(`fixture-${index}.example.invalid`);
    const future = await seed("future.example.invalid", 180);
    const paused = await seed("paused.example.invalid", -200, true);
    const result = await checks.claimChecks(batch);
    expect(result.jobs).toHaveLength(15);
    expect(result.jobs[0]).toMatchObject({
      monitorId: first, configRev: 1, expectedStatus: "2xx_3xx", dueAt: expect.any(Date),
    });
    expect(result.jobs.some(job => [future, paused].includes(job.monitorId))).toBe(false);
    const [attempt] = (await client.query(
      `SELECT a.state,a.expected_status,a.config_rev,a.attempt_id=m.lease_id AS lease_matches,
        extract(epoch FROM (a.expires_at-a.claimed_at))::int AS ttl
       FROM check_attempts a JOIN monitors m ON m.id=a.monitor_id WHERE a.monitor_id=$1`, [first],
    )).rows;
    expect(attempt).toEqual({
      state: "claimed", expected_status: "2xx_3xx", config_rev: 1, lease_matches: true, ttl: 120,
    });
    expect((await client.query("SELECT last_claimed FROM system_heartbeat WHERE name='checker'")).rows)
      .toEqual([{ last_claimed: 15 }]);
    const second = await checks.claimChecks(batch);
    expect(second.jobs).toHaveLength(1);
    expect(second.jobs[0].monitorId).not.toBe(first);
  });

  it("reclaims an expired lease once and marks the old attempt terminal", async () => {
    const id = await seed("expired.example.invalid");
    const [initial] = (await checks.claimChecks(batch)).jobs;
    await client.query(
      "UPDATE monitors SET lease_until=now()-interval '1 second' WHERE id=$1", [id],
    );
    await client.query(
      `UPDATE check_attempts SET claimed_at=now()-interval '121 seconds',expires_at=now()-interval '1 second'
       WHERE attempt_id=$1`, [initial.attemptId],
    );
    const [replacement] = (await checks.claimChecks(batch)).jobs;
    expect(replacement.monitorId).toBe(id);
    expect(replacement.attemptId).not.toBe(initial.attemptId);
    expect((await client.query("SELECT state,terminal_at IS NOT NULL AS terminal FROM check_attempts WHERE attempt_id=$1",
      [initial.attemptId])).rows).toEqual([{ state: "expired", terminal: true }]);
  });

  it("pauses blocked hosts even before their next due check and closes their incidents", async () => {
    const blocked = await seed("sub.blocked.example.invalid", 180);
    const labelBoundary = await seed("notblocked.example.invalid");
    const exactChild = await seed("sub.exact.example.invalid");
    const exact = await seed("exact.example.invalid", 180, true);
    await client.query(
      `INSERT INTO blocked_hosts(host,include_subdomains,reason)
       VALUES ('blocked.example.invalid',true,'fixture'),('exact.example.invalid',false,'fixture')`,
    );
    await client.query(
      `INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause)
       VALUES ($1,$2,now()-interval '1 minute',now(),'timeout')`, [blocked, owner],
    );
    const result = await checks.claimChecks(batch);
    expect(result.jobs.map(job => job.monitorId).sort()).toEqual([labelBoundary, exactChild].sort());
    expect(result.blocklist).toEqual([
      { host: "blocked.example.invalid", includeSubdomains: true },
      { host: "exact.example.invalid", includeSubdomains: false },
    ]);
    for (const id of [blocked, exact]) {
      expect((await client.query("SELECT is_paused,pause_reason,config_rev FROM monitors WHERE id=$1", [id])).rows)
        .toEqual([{ is_paused: true, pause_reason: "blocked_host", config_rev: 2 }]);
    }
    expect((await client.query("SELECT resolved_reason FROM incidents WHERE monitor_id=$1", [blocked])).rows)
      .toEqual([{ resolved_reason: "blocked" }]);
    expect((await client.query("SELECT kind FROM monitor_events ORDER BY kind")).rows)
      .toEqual([{ kind: "blocked" }, { kind: "blocked" }]);
    expect((await client.query("SELECT id FROM alert_outbox")).rows).toEqual([]);
    await checks.claimChecks(batch);
    expect((await client.query("SELECT kind FROM monitor_events")).rows).toHaveLength(2);
  });

  it("fails closed on invalid blocklist rows without leasing monitors", async () => {
    await seed("ready.example.invalid");
    await client.query("INSERT INTO blocked_hosts(host,reason) VALUES ('localhost','fixture')");
    await expect(checks.claimChecks(batch)).rejects.toThrow("Checker claim could not be completed.");
    expect((await client.query("SELECT attempt_id FROM check_attempts")).rows).toEqual([]);
  });
});
