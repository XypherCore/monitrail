import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createMonitorAccess } from "../data/monitor-access.ts";
import type { AttemptResult } from "./capabilities.ts";
import { ingestResults } from "./check-ingest.ts";
import { createCheckCapabilities } from "./checks.ts";

const owner = "a0000000-0000-4000-8000-000000000001";
const otherOwner = "a0000000-0000-4000-8000-000000000002";
const appUrl = "http://localhost:3309";
const epoch = (offsetMs: number) => new Date(Date.now() + offsetMs);
type Measurement =
  | { statusCode: number; responseMs: number }
  | { errorType: "timeout" | "blocked" | "connect" };
const ok = { statusCode: 204, responseMs: 25 };
const failed = { errorType: "timeout" } as const;

describe("single-use check ingestion", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
    });
    // Freeze only this disposable database's receipt clock for exact boundary tests.
    // Keep the real PostgreSQL timestamp arithmetic, including microseconds.
    await client.exec(`
      CREATE SCHEMA fixture_clock;
      CREATE FUNCTION fixture_clock.clock_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$
        SELECT coalesce(nullif(current_setting('monitrail.fixture_accepted_at',true),'')::timestamptz,
          pg_catalog.clock_timestamp())
      $$;
      SET search_path TO fixture_clock,public,pg_catalog;
    `);
  }, 30_000);

  beforeEach(async () => {
    await client.exec("RESET monitrail.fixture_accepted_at");
    await client.exec("TRUNCATE users, system_heartbeat CASCADE");
    await client.query(
      "INSERT INTO users(id,name) VALUES($1,'Fixture owner'),($2,'Other fixture owner')",
      [owner, otherOwner],
    );
    await client.exec(
      "INSERT INTO system_heartbeat(name,last_tick_at,last_claimed,last_ingested) VALUES ('checker',clock_timestamp(),3,0)",
    );
  });

  afterAll(async () => {
    await client?.close();
  });

  async function rows<Row = Record<string, unknown>>(query: string, params: unknown[] = []) {
    return (await client.query<Row>(query, params)).rows;
  }

  async function monitor(userId = owner) {
    const [{ id }] = await rows<{ id: string }>(
      "INSERT INTO monitors(user_id,name,url,host) VALUES($1,'Fixture monitor','https://fixture.invalid/?private=value','fixture.invalid') RETURNING id",
      [userId],
    );
    return id;
  }

  async function lease(
    monitorId: string,
    startedAt: Date,
    measurement: Measurement = ok,
    options: { claimedAt?: Date; expectedStatus?: "2xx" | "2xx_3xx" } = {},
  ): Promise<AttemptResult> {
    const attemptId = randomUUID();
    const claimedAt = options.claimedAt ?? new Date(startedAt.getTime() - 1000);
    const expiresAt = new Date(claimedAt.getTime() + 120_000);
    const [{ config_rev }] = await rows<{ config_rev: number }>(
      "UPDATE monitors SET lease_id=$1,lease_until=$2 WHERE id=$3 RETURNING config_rev",
      [attemptId, expiresAt, monitorId],
    );
    await client.query(
      "INSERT INTO check_attempts(attempt_id,monitor_id,config_rev,expected_status,claimed_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [attemptId, monitorId, config_rev, options.expectedStatus ?? "2xx", claimedAt, expiresAt],
    );
    return { attemptId, monitorId, configRev: config_rev, startedAt, redirectCount: 0, ...measurement };
  }

  async function accept(result: AttemptResult, outcome = "accepted") {
    expect(await ingestResults(db, { results: [result] })).toEqual([
      { attemptId: result.attemptId, outcome },
    ]);
  }

  async function attempt(id: string) {
    return (await rows("SELECT state,terminal_at FROM check_attempts WHERE attempt_id=$1", [id]))[0];
  }

  async function stored(id: string) {
    return (await rows("SELECT * FROM monitors WHERE id=$1", [id]))[0];
  }

  async function receiptAt(at: string) {
    await client.query("SELECT set_config('monitrail.fixture_accepted_at',$1,false)", [at]);
  }

  async function acceptAt(id: string, at: string, measurement: Measurement = ok) {
    await receiptAt(at);
    const result = await lease(id, new Date(Date.parse(at) - 250), measurement, {
      claimedAt: new Date(Date.parse(at) - 500),
    });
    await accept(result);
    return result;
  }

  async function expectNextAt(id: string, at: string) {
    expect(await rows(
      "SELECT next_check_at=$2::timestamptz AS exact,next_check_at>clock_timestamp() AS future FROM monitors WHERE id=$1",
      [id, at],
    )).toEqual([{ exact: true, future: true }]);
  }

  async function channel(monitorId: string, verified: boolean, linked = true) {
    const [{ id }] = await rows<{ id: string }>(
      "INSERT INTO alert_channels(user_id,type,label,config_enc,is_verified) VALUES($1,'webhook','Fixture','v1.fixture.fixture.fixture',$2) RETURNING id",
      [owner, verified],
    );
    if (linked) {
      await client.query(
        "INSERT INTO monitor_alert_channels(monitor_id,channel_id,user_id) VALUES($1,$2,$3)",
        [monitorId, id, owner],
      );
    }
    return id;
  }

  it("computes success from the snapshot and preserves a slow header measurement", async () => {
    const id = await monitor();
    const result = await lease(id, epoch(-5000), { statusCode: 302, responseMs: 9999 }, {
      expectedStatus: "2xx_3xx",
    });
    await accept(result);
    expect(await rows("SELECT ok,status_code,response_ms,error_type FROM checks")).toEqual([
      { ok: true, status_code: 302, response_ms: 9999, error_type: null },
    ]);
    expect(await stored(id)).toMatchObject({
      status: "up",
      failures: 0,
      successes: 1,
      lease_id: null,
      lease_until: null,
      last_checked_at: result.startedAt,
    });
    expect(await attempt(result.attemptId)).toMatchObject({
      state: "done",
      terminal_at: expect.any(Date),
    });
    expect(await rows("SELECT last_claimed,last_ingested FROM system_heartbeat")).toEqual([
      { last_claimed: 3, last_ingested: 1 },
    ]);
  });

  it.each([
    {
      name: "a receipt 61 seconds late",
      dueAt: "2026-11-27T12:00:00.123456Z",
      acceptedAt: "2026-11-27T12:01:01.987654Z",
      nextAt: "2026-11-27T12:05:00.123456Z",
    },
    {
      name: "a receipt one microsecond before the next slot",
      dueAt: "2026-11-27T12:00:00.123456Z",
      acceptedAt: "2026-11-27T12:05:00.123455Z",
      nextAt: "2026-11-27T12:05:00.123456Z",
    },
    {
      name: "a receipt exactly on the next slot",
      dueAt: "2026-11-27T12:00:00.123456Z",
      acceptedAt: "2026-11-27T12:05:00.123456Z",
      nextAt: "2026-11-27T12:10:00.123456Z",
    },
    {
      name: "a receipt one microsecond after the next slot",
      dueAt: "2026-11-27T12:00:00.123456Z",
      acceptedAt: "2026-11-27T12:05:00.123457Z",
      nextAt: "2026-11-27T12:10:00.123456Z",
    },
    {
      name: "a monitor overdue by several intervals",
      dueAt: "2026-11-27T11:40:00.123456Z",
      acceptedAt: "2026-11-27T12:01:01.987654Z",
      nextAt: "2026-11-27T12:05:00.123456Z",
    },
  ])("keeps the settled due-time grid for $name without catch-up claims", async ({ dueAt, acceptedAt, nextAt }) => {
    const id = await monitor();
    await client.query("UPDATE monitors SET next_check_at=$1 WHERE id=$2", [dueAt, id]);
    await acceptAt(id, acceptedAt);
    await expectNextAt(id, nextAt);
    expect((await createCheckCapabilities(db).claimChecks({ max: 15 })).jobs).toEqual([]);
    expect(await rows("SELECT state FROM check_attempts")).toEqual([{ state: "done" }]);
  });

  it("keeps the same normal grid across repeated late receipts", async () => {
    const id = await monitor();
    await client.query("UPDATE monitors SET next_check_at=$1 WHERE id=$2", ["2026-11-27T12:00:00.123456Z", id]);
    for (const [acceptedAt, nextAt] of [
      ["2026-11-27T12:01:01.987654Z", "2026-11-27T12:05:00.123456Z"],
      ["2026-11-27T12:06:01.987654Z", "2026-11-27T12:10:00.123456Z"],
      ["2026-11-27T12:11:01.987654Z", "2026-11-27T12:15:00.123456Z"],
    ]) {
      await acceptAt(id, acceptedAt);
      await expectNextAt(id, nextAt);
    }
    expect(await rows("SELECT count(*)::int AS count FROM checks")).toEqual([{ count: 3 }]);
  });

  it("keeps 60-second confirmation retries and anchors settled checks to the latest confirmation due", async () => {
    const id = await monitor();
    await client.query("UPDATE monitors SET next_check_at=$1 WHERE id=$2", ["2026-11-27T12:00:00.123456Z", id]);
    const firstFailure = await acceptAt(id, "2026-11-27T12:01:01.987654Z", failed);
    await expectNextAt(id, "2026-11-27T12:02:01.987654Z");
    expect(await rows(
      "SELECT m.next_check_at=a.terminal_at+interval '60 seconds' AS exact FROM monitors m JOIN check_attempts a ON a.monitor_id=m.id WHERE a.attempt_id=$1",
      [firstFailure.attemptId],
    )).toEqual([{ exact: true }]);

    await acceptAt(id, "2026-11-27T12:02:03.112233Z", failed);
    expect(await stored(id)).toMatchObject({ status: "down", failures: 2 });
    await expectNextAt(id, "2026-11-27T12:07:01.987654Z");
    await acceptAt(id, "2026-11-27T12:07:03.112233Z", failed);
    await expectNextAt(id, "2026-11-27T12:12:01.987654Z");

    const firstRecovery = await acceptAt(id, "2026-11-27T12:12:04.223344Z");
    expect(await stored(id)).toMatchObject({ status: "down", successes: 1 });
    await expectNextAt(id, "2026-11-27T12:13:04.223344Z");
    expect(await rows(
      "SELECT m.next_check_at=a.terminal_at+interval '60 seconds' AS exact FROM monitors m JOIN check_attempts a ON a.monitor_id=m.id WHERE a.attempt_id=$1",
      [firstRecovery.attemptId],
    )).toEqual([{ exact: true }]);

    await acceptAt(id, "2026-11-27T12:13:07.334455Z");
    expect(await stored(id)).toMatchObject({ status: "up", successes: 2 });
    await expectNextAt(id, "2026-11-27T12:18:04.223344Z");
    expect(await rows("SELECT resolved_reason FROM incidents")).toEqual([{ resolved_reason: "recovered" }]);
  });

  it("uses the current interval after an interval-only edit preserves the due time and in-flight attempt", async () => {
    const id = await monitor();
    const dueAt = "2026-11-27T12:00:00.123456Z";
    const acceptedAt = "2026-11-27T12:01:01.987654Z";
    await receiptAt(acceptedAt);
    await client.query("UPDATE monitors SET next_check_at=$1 WHERE id=$2", [dueAt, id]);
    const result = await lease(id, new Date(Date.parse(acceptedAt) - 250));
    expect(await createMonitorAccess(db, owner, appUrl).editMonitor(id, {
      name: "Fixture monitor",
      expectedStatus: "2xx",
      intervalSeconds: 600,
    })).toBe(true);
    expect(await stored(id)).toMatchObject({ interval_seconds: 600, config_rev: 1, lease_id: result.attemptId });
    expect(await rows("SELECT next_check_at=$2::timestamptz AS exact FROM monitors WHERE id=$1", [id, dueAt]))
      .toEqual([{ exact: true }]);
    expect(await attempt(result.attemptId)).toMatchObject({ state: "claimed" });
    await accept(result);
    await expectNextAt(id, "2026-11-27T12:10:00.123456Z");
  });

  it("marks nonmatching HTTP status as bad_status and avoids an incident for a flap", async () => {
    const id = await monitor();
    await accept(await lease(id, epoch(-20_000), { statusCode: 302, responseMs: 50 }));
    expect(await stored(id)).toMatchObject({ status: "pending", failures: 1 });
    expect(await rows("SELECT ok,error_type FROM checks")).toEqual([
      { ok: false, error_type: "bad_status" },
    ]);
    expect(await rows(
      "SELECT extract(epoch FROM m.next_check_at-a.terminal_at)::int AS delay FROM monitors m JOIN check_attempts a ON a.monitor_id=m.id",
    )).toEqual([{ delay: 60 }]);
    await accept(await lease(id, epoch(-15_000)));
    expect(await stored(id)).toMatchObject({ status: "up", failures: 0 });
    expect(await rows("SELECT id FROM incidents")).toEqual([]);
  });

  it("queues recovery for active recipients with a sent or deliverable down event", async () => {
    const id = await monitor();
    const delivered = await channel(id, true);
    const pending = await channel(id, true);
    const sending = await channel(id, true);
    const failedDelivery = await channel(id, true);
    const unsubscribed = await channel(id, true);
    await channel(id, false);
    await channel(id, true, false);
    const first = await lease(id, epoch(-25_000), failed);
    await accept(first);
    await accept(await lease(id, epoch(-20_000), { statusCode: 503, responseMs: 50 }));
    expect(await stored(id)).toMatchObject({ status: "down", failures: 2 });
    const [opened] = await rows("SELECT * FROM incidents");
    expect(opened).toMatchObject({ started_at: first.startedAt, cause: "timeout", resolved_at: null });
    expect(opened.confirmed_at).toBeInstanceOf(Date);
    const down = await rows("SELECT id,channel_id,kind,payload FROM alert_outbox ORDER BY channel_id");
    expect(down.map((row) => row.channel_id))
      .toEqual([delivered, pending, sending, failedDelivery, unsubscribed].sort());
    for (const event of down) {
      expect(event).toMatchObject({
        kind: "down",
        payload: {
          version: 1,
          event_id: event.id,
          event: "incident.opened",
          monitor: { name: "Fixture monitor" },
          incident: { cause: "timeout", resolved_at: null },
        },
      });
      expect(JSON.stringify(event.payload)).not.toContain("private");
      expect(JSON.stringify(event.payload)).not.toContain("config_enc");
    }
    await client.query(
      "UPDATE alert_outbox SET status='sent',sent_at=clock_timestamp() WHERE channel_id=$1",
      [delivered],
    );
    await client.query(
      "UPDATE alert_outbox SET status='sending',claimed_until=clock_timestamp()+interval '30 seconds' WHERE channel_id=$1",
      [sending],
    );
    await client.query("UPDATE alert_outbox SET status='failed' WHERE channel_id=$1", [failedDelivery]);
    await client.query("DELETE FROM monitor_alert_channels WHERE channel_id=$1", [unsubscribed]);
    await channel(id, true); // A new subscription has no down event for this incident.
    const recovery = await lease(id, epoch(-15_000));
    await accept(recovery);
    expect(await stored(id)).toMatchObject({ status: "down", successes: 1 });
    const confirmation = await lease(id, epoch(-10_000));
    await accept(confirmation);
    await accept(confirmation, "dropped");
    expect(await stored(id)).toMatchObject({ status: "up", successes: 2 });
    expect(await rows("SELECT id,resolved_at,resolved_reason,resolved_confirmed_at FROM incidents"))
      .toEqual([{
        id: opened.id,
        resolved_at: recovery.startedAt,
        resolved_reason: "recovered",
        resolved_confirmed_at: expect.any(Date),
      }]);
    const up = await rows("SELECT id,channel_id,status,payload FROM alert_outbox WHERE kind='up' ORDER BY channel_id");
    expect(up.map((row) => row.channel_id)).toEqual([delivered, pending, sending].sort());
    for (const event of up) {
      expect(event).toMatchObject({
        status: "pending",
        payload: {
          event: "incident.resolved",
          event_id: event.id,
          incident: { resolved_at: expect.any(String) },
        },
      });
    }
  });

  it("accepts one concurrent replay and leaves the first committed record untouched", async () => {
    const result = await lease(await monitor(), epoch(-5000));
    const replies = await Promise.all([
      ingestResults(db, { results: [result] }),
      ingestResults(db, { results: [result] }),
    ]);
    expect(replies.flat().map((reply) => reply.outcome).sort()).toEqual(["accepted", "dropped"]);
    expect(await rows("SELECT attempt_id FROM checks")).toEqual([{ attempt_id: result.attemptId }]);
    expect(await attempt(result.attemptId)).toMatchObject({ state: "done" });
  });

  it("drops an expired result before a reclaim and records the expiry", async () => {
    const id = await monitor();
    const result = await lease(id, epoch(-125_000));
    await accept(result, "dropped");
    expect(await attempt(result.attemptId)).toMatchObject({ state: "expired", terminal_at: expect.any(Date) });
    expect(await stored(id)).toMatchObject({ status: "pending", lease_id: result.attemptId });
    expect(await rows("SELECT attempt_id FROM checks")).toEqual([]);
  });

  it("leaves the replacement lease and a different monitor's attempt untouched", async () => {
    const id = await monitor();
    const old = await lease(id, epoch(-10_000));
    const replacement = await lease(id, epoch(-5000));
    const foreignMonitor = await monitor(otherOwner);
    await accept({ ...replacement, monitorId: foreignMonitor }, "dropped");
    expect(await attempt(replacement.attemptId)).toMatchObject({ state: "claimed" });
    await accept(old, "dropped");
    expect(await stored(id)).toMatchObject({ lease_id: replacement.attemptId, status: "pending" });
    expect(await attempt(old.attemptId)).toMatchObject({ state: "dropped" });
    await accept(replacement);
  });

  it("drops an equal or older observation and never creates a check for a deleted monitor", async () => {
    const id = await monitor();
    const result = await lease(id, epoch(-5000));
    await client.query("UPDATE monitors SET last_checked_at=$1 WHERE id=$2", [result.startedAt, id]);
    await accept(result, "dropped");
    expect(await attempt(result.attemptId)).toMatchObject({ state: "dropped" });
    await client.query("DELETE FROM monitors WHERE id=$1", [id]);
    await accept(result, "dropped");
    expect(await rows("SELECT attempt_id FROM checks")).toEqual([]);
  });

  it.each(["pause", "edit"] as const)("drops results from before a %s change", async (change) => {
    const id = await monitor();
    const result = await lease(id, epoch(-5000));
    const access = createMonitorAccess(db, owner, appUrl);
    if (change === "pause") {
      expect(await access.setMonitorPaused(id, true)).toBe(true);
    } else {
      expect(await access.editMonitor(id, {
        name: "Edited fixture",
        expectedStatus: "2xx_3xx",
        intervalSeconds: 300,
      })).toBe(true);
    }
    await accept(result, "dropped");
    expect(await stored(id)).toMatchObject({ config_rev: 2, lease_id: null, last_checked_at: null });
    expect(await attempt(result.attemptId)).toMatchObject({ state: "dropped" });
  });

  it("clamps a worker clock slightly before the claim or ahead of receipt", async () => {
    const early = await monitor();
    const late = await monitor();
    const claimedAt = epoch(-5000);
    const first = await lease(early, epoch(-20_000), ok, { claimedAt });
    const second = await lease(late, epoch(20_000), ok, { claimedAt });
    await accept(first);
    await accept(second);
    expect(await stored(early)).toMatchObject({ last_checked_at: claimedAt });
    expect(await rows(
      "SELECT c.checked_at=a.terminal_at AS clamped FROM checks c JOIN check_attempts a USING(attempt_id) WHERE c.monitor_id=$1",
      [late],
    )).toEqual([{ clamped: true }]);
  });

  it.each([-65_000, 65_000])("drops a worker clock beyond tolerated skew (%s ms)", async (offset) => {
    const id = await monitor();
    const result = await lease(id, epoch(offset), ok, { claimedAt: epoch(-1000) });
    await accept(result, "dropped");
    expect(await attempt(result.attemptId)).toMatchObject({ state: "dropped" });
    expect(await rows("SELECT attempt_id FROM checks")).toEqual([]);
  });

  it("rolls back a check and incident if the outbox write fails", async () => {
    const id = await monitor();
    await channel(id, true);
    await accept(await lease(id, epoch(-10_000), failed));
    const result = await lease(id, epoch(-5000), failed);
    await client.exec("ALTER TABLE alert_outbox ADD CONSTRAINT reject_pending_fixture CHECK (status <> 'pending')");
    try {
      await accept(result, "error");
    } finally {
      await client.exec("ALTER TABLE alert_outbox DROP CONSTRAINT reject_pending_fixture");
    }
    expect(await stored(id)).toMatchObject({ status: "pending", failures: 1, lease_id: result.attemptId });
    expect(await attempt(result.attemptId)).toMatchObject({ state: "claimed", terminal_at: null });
    expect(await rows("SELECT id FROM incidents")).toEqual([]);
    expect(await rows("SELECT id FROM alert_outbox")).toEqual([]);
    expect(await rows("SELECT attempt_id FROM checks WHERE attempt_id=$1", [result.attemptId])).toEqual([]);
    await accept(result);
    expect(await stored(id)).toMatchObject({ status: "down", failures: 2 });
  });
});
