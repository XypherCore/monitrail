import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fixtureOwners, seedFixtures } from "../../scripts/db/fixtures.ts";

const ownerA = "10000000-0000-4000-8000-000000000001";
const ownerB = "10000000-0000-4000-8000-000000000002";
const monitorA = "20000000-0000-4000-8000-000000000001";
const monitorB = "20000000-0000-4000-8000-000000000002";
const channelA = "30000000-0000-4000-8000-000000000001";
const channelB = "30000000-0000-4000-8000-000000000002";
const pageA = "40000000-0000-4000-8000-000000000001";
const incidentA = "50000000-0000-4000-8000-000000000001";

describe("committed PostgreSQL migrations", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
    });
  }, 30_000);

  beforeEach(async () => {
    // This is a private in-memory PostgreSQL instance, never DATABASE_URL.
    await client.exec("TRUNCATE users, blocked_hosts, verification RESTART IDENTITY CASCADE");
    await client.query("INSERT INTO users (id,email,name) VALUES ($1,'owner-a@example.invalid','Fixture A'),($2,'owner-b@example.invalid','Fixture B')", [ownerA, ownerB]);
    await client.query("INSERT INTO monitors (id,user_id,name,url) VALUES ($1,$2,'Fixture A','https://a.example.invalid'),($3,$4,'Fixture B','https://b.example.invalid')", [monitorA, ownerA, monitorB, ownerB]);
    // Opaque bytes exercise relational integrity, not encryption or delivery.
    await client.query("INSERT INTO alert_channels (id,user_id,type,label,config_encrypted) VALUES ($1,$2,'webhook','Fixture A',decode('00','hex')),($3,$4,'webhook','Fixture B',decode('00','hex'))", [channelA, ownerA, channelB, ownerB]);
    await client.query("INSERT INTO status_pages (id,user_id,slug,title) VALUES ($1,$2,'fixture-a','Fixture page')", [pageA, ownerA]);
  });

  afterAll(async () => { await client?.close(); });

  it("creates every domain/auth table and uses timezone-aware timestamps", async () => {
    const tables = await client.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    expect(tables.rows.map(row => row.table_name)).toEqual([
      "accounts", "alert_channels", "alert_events", "blocked_hosts", "check_rollups_hourly", "checks", "incidents", "monitor_alert_channels", "monitors", "sessions", "status_page_monitors", "status_pages", "users", "verification",
    ]);
    const naive = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='timestamp without time zone'");
    expect(naive.rows).toEqual([]);
  });

  it("rejects a second open incident, but permits historical incidents and reopening", async () => {
    await client.query("INSERT INTO incidents(id,monitor_id,user_id,started_at,cause) VALUES($1,$2,$3,now(),'timeout')", [incidentA, monitorA, ownerA]);
    await expect(client.query("INSERT INTO incidents(monitor_id,user_id,started_at,cause) VALUES($1,$2,now(),'dns')", [monitorA, ownerA])).rejects.toMatchObject({ code: "23505" });
    await client.query("UPDATE incidents SET resolved_at=now() WHERE id=$1 AND user_id=$2", [incidentA, ownerA]);
    await client.query("INSERT INTO incidents(monitor_id,user_id,started_at,cause) VALUES($1,$2,now(),'dns')", [monitorA, ownerA]);
    const open = await client.query("SELECT id FROM incidents WHERE monitor_id=$1 AND resolved_at IS NULL", [monitorA]);
    expect(open.rows).toHaveLength(1);
  });

  it("enforces ownership on both ends of monitor/channel and page/monitor links", async () => {
    await expect(client.query("INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES($1,$2,$3)", [ownerA, monitorA, channelB])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES($1,$2,$3)", [ownerB, monitorA, channelB])).rejects.toMatchObject({ code: "23503" });
    await expect(client.query("INSERT INTO status_page_monitors(user_id,status_page_id,monitor_id) VALUES($1,$2,$3)", [ownerA, pageA, monitorB])).rejects.toMatchObject({ code: "23503" });
    await client.query("INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES($1,$2,$3)", [ownerA, monitorA, channelA]);
    await client.query("INSERT INTO status_page_monitors(user_id,status_page_id,monitor_id) VALUES($1,$2,$3)", [ownerA, pageA, monitorA]);
  });

  it("enforces incident/event ownership and deduplicates alert event records", async () => {
    await expect(client.query("INSERT INTO incidents(monitor_id,user_id,started_at,cause) VALUES($1,$2,now(),'timeout')", [monitorB, ownerA])).rejects.toMatchObject({ code: "23503" });
    await client.query("INSERT INTO incidents(id,monitor_id,user_id,started_at,cause) VALUES($1,$2,$3,now(),'timeout')", [incidentA, monitorA, ownerA]);
    await expect(client.query("INSERT INTO alert_events(incident_id,channel_id,user_id,kind) VALUES($1,$2,$3,'down')", [incidentA, channelB, ownerA])).rejects.toMatchObject({ code: "23503" });
    await client.query("INSERT INTO alert_events(incident_id,channel_id,user_id,kind) VALUES($1,$2,$3,'down')", [incidentA, channelA, ownerA]);
    await expect(client.query("INSERT INTO alert_events(incident_id,channel_id,user_id,kind) VALUES($1,$2,$3,'down')", [incidentA, channelA, ownerA])).rejects.toMatchObject({ code: "23505" });
    await client.query("INSERT INTO alert_events(incident_id,channel_id,user_id,kind) VALUES($1,$2,$3,'up')", [incidentA, channelA, ownerA]);
  });

  it("preserves specified defaults and rejects sub-minimum intervals", async () => {
    const result = await client.query<{ interval_seconds: number; timeout_ms: number; status: string; is_paused: boolean; expected_status: string }>("SELECT interval_seconds,timeout_ms,status,is_paused,expected_status FROM monitors WHERE id=$1", [monitorA]);
    expect(result.rows[0]).toEqual({ interval_seconds: 300, timeout_ms: 10000, status: "pending", is_paused: false, expected_status: "2xx" });
    await expect(client.query("UPDATE monitors SET interval_seconds=299 WHERE id=$1", [monitorA])).rejects.toMatchObject({ code: "23514" });
    await client.query("UPDATE monitors SET interval_seconds=300 WHERE id=$1", [monitorA]);
    await expect(client.query("UPDATE monitors SET failures=-1 WHERE id=$1", [monitorA])).rejects.toMatchObject({ code: "23514" });
    await expect(client.query("UPDATE monitors SET status='paused',is_paused=false WHERE id=$1", [monitorA])).rejects.toMatchObject({ code: "23514" });
    const page = await client.query<{ is_published: boolean }>("SELECT is_published FROM status_pages WHERE id=$1", [pageA]);
    expect(page.rows[0]?.is_published).toBe(false);
  });

  it("supports OAuth identities without permitting password storage", async () => {
    await client.query("INSERT INTO accounts(user_id,account_id,provider_id) VALUES($1,'fixture-provider-id','github')", [ownerA]);
    await expect(client.query("INSERT INTO accounts(user_id,account_id,provider_id) VALUES($1,'fixture-provider-id','github')", [ownerB])).rejects.toMatchObject({ code: "23505" });
    await expect(client.query("INSERT INTO accounts(user_id,account_id,provider_id,password) VALUES($1,'fixture-password-id','credential','not-a-real-password')", [ownerA])).rejects.toMatchObject({ code: "23514" });
  });

  it("cascades a user's owned data while preserving the other user", async () => {
    await client.query("INSERT INTO checks(monitor_id,checked_at,ok,response_ms) VALUES($1,now(),true,42)", [monitorA]);
    await client.query("INSERT INTO check_rollups_hourly(monitor_id,hour,total,failed,avg_ms,p95_ms,max_ms) VALUES($1,date_trunc('hour',now()),1,0,42,42,42)", [monitorA]);
    await client.query("INSERT INTO incidents(id,monitor_id,user_id,started_at,cause) VALUES($1,$2,$3,now(),'timeout')", [incidentA, monitorA, ownerA]);
    await client.query("INSERT INTO alert_events(incident_id,channel_id,user_id,kind) VALUES($1,$2,$3,'down')", [incidentA, channelA, ownerA]);
    await client.query("INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES($1,$2,$3)", [ownerA, monitorA, channelA]);
    await client.query("INSERT INTO status_page_monitors(user_id,status_page_id,monitor_id) VALUES($1,$2,$3)", [ownerA, pageA, monitorA]);
    await client.query("INSERT INTO sessions(user_id,token,expires_at) VALUES($1,'non-secret-fixture-token',now()+interval '1 day')", [ownerA]);
    await client.query("INSERT INTO accounts(user_id,account_id,provider_id) VALUES($1,'fixture-provider-id','github')", [ownerA]);
    await client.query("INSERT INTO verification(user_id,identifier,value,expires_at) VALUES($1,'fixture','non-secret-fixture-value',now()+interval '1 day')", [ownerA]);
    await client.query("DELETE FROM users WHERE id=$1", [ownerA]);
    const counts = await client.query<{ remaining: number }>("SELECT (SELECT count(*) FROM checks)::int + (SELECT count(*) FROM check_rollups_hourly)::int + (SELECT count(*) FROM incidents)::int + (SELECT count(*) FROM alert_events)::int + (SELECT count(*) FROM monitor_alert_channels)::int + (SELECT count(*) FROM status_pages)::int + (SELECT count(*) FROM status_page_monitors)::int + (SELECT count(*) FROM sessions)::int + (SELECT count(*) FROM accounts)::int + (SELECT count(*) FROM verification)::int AS remaining");
    expect(counts.rows[0]?.remaining).toBe(0);
    expect((await client.query("SELECT id FROM monitors")).rows).toEqual([{ id: monitorB }]);
    expect((await client.query("SELECT id FROM alert_channels")).rows).toEqual([{ id: channelB }]);
  });

  it("seeds fake paused monitors idempotently without network or channel credentials", async () => {
    await client.exec("TRUNCATE users CASCADE");
    const db = drizzle(client);
    const now = new Date("2026-01-01T12:00:00.000Z");
    await db.transaction(async tx => seedFixtures(tx, now));
    const first = await client.query("SELECT * FROM checks ORDER BY id");
    await client.query("UPDATE monitors SET last_checked_at=$1 WHERE user_id=$2", [new Date(now.getTime() + 3600_000), fixtureOwners[0].id]);
    await db.transaction(async tx => seedFixtures(tx, new Date(now.getTime() + 86400_000)));
    expect((await client.query("SELECT * FROM checks ORDER BY id")).rows).toEqual(first.rows);
    expect(first.rows.length).toBeGreaterThan(0);
    expect((await client.query("SELECT id FROM monitors WHERE is_paused=false")).rows).toEqual([]);
    expect((await client.query("SELECT id FROM alert_channels")).rows).toEqual([]);
  });

  it("rolls back the seed when an incident fixture ID belongs to another monitor", async () => {
    const fixtureIncident = "d3000000-0000-4000-8000-000000000001";
    await client.query("INSERT INTO incidents(id,monitor_id,user_id,started_at,cause) VALUES($1,$2,$3,now(),'dns')", [fixtureIncident, monitorB, ownerB]);
    await expect(drizzle(client).transaction(tx => seedFixtures(tx))).rejects.toThrow("Fixture incident collision");
    expect((await client.query("SELECT id FROM users WHERE id=$1 OR id=$2", fixtureOwners.map(owner => owner.id))).rows).toEqual([]);
    expect((await client.query("SELECT monitor_id,user_id FROM incidents WHERE id=$1", [fixtureIncident])).rows).toEqual([{ monitor_id: monitorB, user_id: ownerB }]);
  });

  it("refuses to seed under an unrelated user's fixed fixture ID", async () => {
    await client.query("INSERT INTO users(id,email,name) VALUES($1,'different@example.invalid','Unrelated fixture')", [fixtureOwners[0].id]);
    await expect(drizzle(client).transaction(tx => seedFixtures(tx))).rejects.toThrow("Fixture identity collision");
    expect((await client.query("SELECT id FROM monitors WHERE user_id=$1", [fixtureOwners[0].id])).rows).toEqual([]);
  });
});
