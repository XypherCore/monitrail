import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../../drizzle-rev2", import.meta.url));
const ownerA = "10000000-0000-4000-8000-000000000001";
const ownerB = "10000000-0000-4000-8000-000000000002";
const monitorA = "20000000-0000-4000-8000-000000000001";
const monitorB = "20000000-0000-4000-8000-000000000002";
const channelA = "30000000-0000-4000-8000-000000000001";
const channelB = "30000000-0000-4000-8000-000000000002";
const pageA = "40000000-0000-4000-8000-000000000001";
const pageB = "40000000-0000-4000-8000-000000000002";
const incidentA = "50000000-0000-4000-8000-000000000001";
const attemptA = "60000000-0000-4000-8000-000000000001";
const attemptB = "60000000-0000-4000-8000-000000000002";

describe("rev 2 clean-target PostgreSQL migration", () => {
  let client: PGlite;

  beforeAll(async () => {
    client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder });
  }, 30_000);

  beforeEach(async () => {
    await client.exec(
      "TRUNCATE users, invites, slug_tombstones, blocked_hosts, rate_limits, system_heartbeat RESTART IDENTITY CASCADE",
    );
    await client.query("INSERT INTO users (id,name) VALUES ($1,'Fixture A'),($2,'Fixture B')", [
      ownerA,
      ownerB,
    ]);
    await client.query(
      "INSERT INTO monitors (id,user_id,name,url,host) VALUES ($1,$2,'Fixture A','https://a.example.invalid','a.example.invalid'),($3,$4,'Fixture B','https://b.example.invalid','b.example.invalid')",
      [monitorA, ownerA, monitorB, ownerB],
    );
    // Non-credential strings exercise ownership and cascade behavior only.
    await client.query(
      "INSERT INTO alert_channels (id,user_id,type,label,config_enc) VALUES ($1,$2,'webhook','Fixture A','v1.fixture.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA'),($3,$4,'slack','Fixture B','v1.fixture.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA')",
      [channelA, ownerA, channelB, ownerB],
    );
    await client.query(
      "INSERT INTO status_pages (id,user_id,slug,title) VALUES ($1,$2,'fixture-a','Fixture A'),($3,$4,'fixture-b','Fixture B')",
      [pageA, ownerA, pageB, ownerB],
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  async function insertIncident() {
    return client.query(
      "INSERT INTO incidents (id,monitor_id,user_id,started_at,confirmed_at,cause) VALUES ($1,$2,$3,now(),now(),'timeout')",
      [incidentA, monitorA, ownerA],
    );
  }

  const channelLink =
    "INSERT INTO monitor_alert_channels (user_id,monitor_id,channel_id) VALUES ($1,$2,$3)";
  const pageLink =
    "INSERT INTO status_page_monitors (user_id,status_page_id,monitor_id) VALUES ($1,$2,$3)";
  const enqueue =
    "INSERT INTO alert_outbox (incident_id,channel_id,user_id,kind,dedupe_key,payload) VALUES ($1,$2,$3,'down',$4,'{}')";
  const claim =
    "INSERT INTO check_attempts (attempt_id,monitor_id,config_rev,expected_status,claimed_at,expires_at) VALUES ($1,$2,1,'2xx',now(),now()+interval '120 seconds')";
  const accepted =
    "INSERT INTO checks (attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms) VALUES ($1,$2,1,now(),true,200,10)";

  it("creates the 19 app tables and can be replayed safely", async () => {
    await migrate(drizzle(client), { migrationsFolder });
    const tables = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "accounts",
      "alert_channels",
      "alert_outbox",
      "blocked_hosts",
      "check_attempts",
      "checks",
      "incidents",
      "invites",
      "monitor_alert_channels",
      "monitor_events",
      "monitors",
      "rate_limits",
      "sessions",
      "slug_tombstones",
      "status_page_monitors",
      "status_pages",
      "system_heartbeat",
      "telegram_link_codes",
      "users",
    ]);
    const naive = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND data_type='timestamp without time zone'",
    );
    expect(naive.rows).toEqual([]);
  });

  it("permits missing emails and prevents ambiguous provider identity and email collisions", async () => {
    expect((await client.query("SELECT email FROM users ORDER BY id")).rows).toEqual([
      { email: null },
      { email: null },
    ]);
    await client.query("UPDATE users SET email='fixture@example.invalid' WHERE id=$1", [ownerA]);
    await expect(
      client.query("UPDATE users SET email='FIXTURE@example.invalid' WHERE id=$1", [ownerB]),
    ).rejects.toMatchObject({ code: "23505" });
    const insertAccount =
      "INSERT INTO accounts (user_id,provider,provider_account_id) VALUES ($1,$2,$3)";
    await client.query(insertAccount, [ownerA, "github", "fixture-subject"]);
    await expect(
      client.query(insertAccount, [ownerB, "github", "fixture-subject"]),
    ).rejects.toMatchObject({ code: "23505" });
    await client.query(insertAccount, [ownerB, "google", "fixture-subject"]);
  });

  it("persists the documented monitor defaults and restricts stored intervals and states", async () => {
    expect(
      (
        await client.query(
          "SELECT config_rev,interval_seconds,expected_status,status,is_paused,pause_reason FROM monitors WHERE id=$1",
          [monitorA],
        )
      ).rows,
    ).toEqual([
      {
        config_rev: 1,
        interval_seconds: 300,
        expected_status: "2xx",
        status: "pending",
        is_paused: false,
        pause_reason: null,
      },
    ]);
    for (const interval of [300, 600, 900, 1800, 3600]) {
      await client.query("UPDATE monitors SET interval_seconds=$1 WHERE id=$2", [
        interval,
        monitorA,
      ]);
    }
    await expect(
      client.query("UPDATE monitors SET interval_seconds=301 WHERE id=$1", [monitorA]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("UPDATE monitors SET expected_status='2xx_3xx' WHERE id=$1", [monitorA]);
    await expect(
      client.query("UPDATE monitors SET expected_status='200' WHERE id=$1", [monitorA]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE monitors SET status='paused' WHERE id=$1", [monitorA]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE monitors SET is_paused=true WHERE id=$1", [monitorA]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("UPDATE monitors SET is_paused=true,pause_reason='user' WHERE id=$1", [
      monitorA,
    ]);
    await expect(
      client.query("UPDATE monitors SET failures=-1 WHERE id=$1", [monitorA]),
    ).rejects.toMatchObject({ code: "23514" });
    const columns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='monitors' AND column_name IN ('method','timeout_ms')",
    );
    expect(columns.rows).toEqual([]);
  });

  it("preserves one open incident per monitor and allows a closed incident before reopening", async () => {
    await insertIncident();
    const open =
      "INSERT INTO incidents (monitor_id,user_id,started_at,confirmed_at,cause) VALUES ($1,$2,now(),now(),'dns')";
    await expect(client.query(open, [monitorA, ownerA])).rejects.toMatchObject({ code: "23505" });
    await expect(
      client.query("UPDATE incidents SET resolved_at=now() WHERE id=$1", [incidentA]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(
      "UPDATE incidents SET resolved_at=now(),resolved_reason='paused' WHERE id=$1",
      [incidentA],
    );
    await client.query(open, [monitorA, ownerA]);
    expect(
      (await client.query("SELECT id FROM incidents WHERE resolved_at IS NULL")).rows,
    ).toHaveLength(1);
  });

  it("blocks cross-owner channel and page associations from either side", async () => {
    for (const userId of [ownerA, ownerB]) {
      await expect(client.query(channelLink, [userId, monitorA, channelB])).rejects.toMatchObject({
        code: "23503",
      });
      await expect(client.query(pageLink, [userId, pageA, monitorB])).rejects.toMatchObject({
        code: "23503",
      });
    }
    await client.query(channelLink, [ownerA, monitorA, channelA]);
    await client.query(pageLink, [ownerA, pageA, monitorA]);
    expect((await client.query("SELECT show_url FROM status_page_monitors")).rows).toEqual([
      { show_url: false },
    ]);
  });

  it("enforces incident and outbox ownership, canonical dedupe and allowlisted errors", async () => {
    await expect(
      client.query(
        "INSERT INTO incidents (monitor_id,user_id,started_at,confirmed_at,cause) VALUES ($1,$2,now(),now(),'dns')",
        [monitorA, ownerB],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await insertIncident();
    for (const userId of [ownerA, ownerB]) {
      await expect(
        client.query(enqueue, [incidentA, channelB, userId, `${incidentA}:${channelB}:down`]),
      ).rejects.toMatchObject({ code: "23503" });
    }
    const event = [incidentA, channelA, ownerA, `${incidentA}:${channelA}:down`];
    await expect(
      client.query(enqueue, [incidentA, channelA, ownerA, "wrong-key"]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(enqueue, event);
    await expect(client.query(enqueue, event)).rejects.toMatchObject({ code: "23505" });
    await expect(
      client.query("UPDATE alert_outbox SET last_error_category='raw-message'"),
    ).rejects.toMatchObject({ code: "22P02" });
  });

  it("retains check history when an attempt is purged and rejects replayed check IDs", async () => {
    await client.query(claim, [attemptA, monitorA]);
    await client.query(accepted, [attemptA, monitorA]);
    await expect(
      client.query("UPDATE check_attempts SET state='done' WHERE attempt_id=$1", [attemptA]),
    ).rejects.toMatchObject({ code: "23514" });
    await client.query(
      "UPDATE check_attempts SET state='done',terminal_at=now() WHERE attempt_id=$1",
      [attemptA],
    );
    await client.query("DELETE FROM check_attempts WHERE attempt_id=$1", [attemptA]);
    expect((await client.query("SELECT attempt_id FROM checks")).rows).toEqual([
      { attempt_id: attemptA },
    ]);
    await expect(client.query(accepted, [attemptA, monitorA])).rejects.toMatchObject({
      code: "23505",
    });
    await expect(client.query("UPDATE checks SET redirect_count=3")).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("enforces valid slugs and canonical blocklist shape", async () => {
    await expect(
      client.query("UPDATE status_pages SET slug='Fixture-A' WHERE id=$1", [pageA]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE status_pages SET slug='fixture a' WHERE id=$1", [pageA]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      client.query("UPDATE status_pages SET slug='fixture-a' WHERE id=$1", [pageB]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      client.query("INSERT INTO blocked_hosts (host,reason) VALUES ('EXAMPLE.invalid.','fixture')"),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await client.query(
          "INSERT INTO blocked_hosts (host,reason) VALUES ('example.invalid','fixture') RETURNING include_subdomains",
        )
      ).rows,
    ).toEqual([{ include_subdomains: true }]);
  });

  it("cascades every owned row and leaves a consumed invite unusable", async () => {
    await client.query(
      "INSERT INTO accounts (user_id,provider,provider_account_id) VALUES ($1,'github','fixture-a'),($2,'github','fixture-b')",
      [ownerA, ownerB],
    );
    await client.query(
      "INSERT INTO sessions (user_id,session_token,expires) VALUES ($1,'fixture-a',now()+interval '1 day'),($2,'fixture-b',now()+interval '1 day')",
      [ownerA, ownerB],
    );
    await client.query(
      "INSERT INTO invites (code_hash,used_by,used_at) VALUES ('fixture-hash',$1,now())",
      [ownerA],
    );
    await client.query(
      "INSERT INTO telegram_link_codes (code_hash,user_id,expires_at) VALUES ('fixture-a',$1,now()+interval '10 minutes'),('fixture-b',$2,now()+interval '10 minutes')",
      [ownerA, ownerB],
    );
    await client.query(claim, [attemptA, monitorA]);
    await client.query(claim, [attemptB, monitorB]);
    await client.query(accepted, [attemptA, monitorA]);
    await client.query("INSERT INTO monitor_events (monitor_id,kind) VALUES ($1,'created')", [
      monitorA,
    ]);
    await insertIncident();
    await client.query(enqueue, [incidentA, channelA, ownerA, `${incidentA}:${channelA}:down`]);
    await client.query(channelLink, [ownerA, monitorA, channelA]);
    await client.query(pageLink, [ownerA, pageA, monitorA]);

    await client.query("DELETE FROM users WHERE id=$1", [ownerA]);
    for (const table of [
      "accounts",
      "sessions",
      "monitors",
      "alert_channels",
      "telegram_link_codes",
      "status_pages",
    ]) {
      expect((await client.query(`SELECT user_id FROM ${table}`)).rows).toEqual([
        { user_id: ownerB },
      ]);
    }
    expect((await client.query("SELECT monitor_id FROM check_attempts")).rows).toEqual([
      { monitor_id: monitorB },
    ]);
    for (const table of [
      "checks",
      "monitor_events",
      "incidents",
      "alert_outbox",
      "monitor_alert_channels",
      "status_page_monitors",
    ]) {
      expect((await client.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
    expect(
      (await client.query("SELECT used_by,used_at IS NOT NULL AS consumed FROM invites")).rows,
    ).toEqual([{ used_by: null, consumed: true }]);
  });
});
