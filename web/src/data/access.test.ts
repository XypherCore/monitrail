import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorRange } from "../monitors/insight-types.ts";
import { createDataAccess, DataAccessError } from "./access.ts";

const ownerA = "10000000-0000-4000-8000-000000000001";
const ownerB = "10000000-0000-4000-8000-000000000002";
const monitorA = "20000000-0000-4000-8000-000000000001";
const monitorB = "20000000-0000-4000-8000-000000000002";
const channelA = "30000000-0000-4000-8000-000000000001";
const channelB = "30000000-0000-4000-8000-000000000002";
const pageA = "40000000-0000-4000-8000-000000000001";
const pageB = "40000000-0000-4000-8000-000000000002";
const incidentA = "50000000-0000-4000-8000-000000000001";
const incidentB = "50000000-0000-4000-8000-000000000002";
const missing = "60000000-0000-4000-8000-000000000099";
const clock = new Date("2026-01-01T12:00:00.000Z");

describe("ownership data-access layer against PostgreSQL migrations", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    client = new PGlite();
    db = drizzle(client);
    await migrate(db, {
      migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
    });
  }, 30_000);

  beforeEach(async () => {
    // This database is private in-memory PostgreSQL, never DATABASE_URL.
    await client.exec("TRUNCATE users RESTART IDENTITY CASCADE");
    await client.query(
      "INSERT INTO users(id,email,name) VALUES($1,'owner-a@example.invalid','Fixture A'),($2,'owner-b@example.invalid','Fixture B')",
      [ownerA, ownerB],
    );
    await client.query(
      "INSERT INTO monitors(id,user_id,name,url,host,created_at,last_checked_at) VALUES($1,$2,'Monitor A','https://a.example.invalid','a.example.invalid',$5,$5),($3,$4,'Monitor B','https://b.example.invalid','b.example.invalid',$5,$5)",
      [monitorA, ownerA, monitorB, ownerB, clock],
    );
    // Dummy bytes exercise redaction/ownership, not encryption implementation.
    await client.query(
      "INSERT INTO alert_channels(id,user_id,type,label,config_enc,is_verified) VALUES($1,$2,'webhook','Channel A','fixture-envelope',true),($3,$4,'webhook','Channel B','fixture-envelope',true)",
      [channelA, ownerA, channelB, ownerB],
    );
    await client.query(
      "INSERT INTO status_pages(id,user_id,slug,title) VALUES($1,$2,'owner-a','Page A'),($3,$4,'owner-b','Page B')",
      [pageA, ownerA, pageB, ownerB],
    );
    await client.query(
      "INSERT INTO incidents(id,monitor_id,user_id,started_at,confirmed_at,cause) VALUES($1,$2,$3,$4,$4,'timeout'),($5,$6,$7,$4,$4,'dns')",
      [incidentA, monitorA, ownerA, clock, incidentB, monitorB, ownerB],
    );
    for (const [userId, monitorId, channelId, pageId, incidentId] of [
      [ownerA, monitorA, channelA, pageA, incidentA],
      [ownerB, monitorB, channelB, pageB, incidentB],
    ]) {
      await client.query(
        "INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms) VALUES($1,$1,1,$2,true,200,42)",
        [monitorId, clock],
      );
      await client.query(
        "INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES($1,$2,$3)",
        [userId, monitorId, channelId],
      );
      await client.query(
        "INSERT INTO status_page_monitors(user_id,status_page_id,monitor_id) VALUES($1,$2,$3)",
        [userId, pageId, monitorId],
      );
      await client.query(
        "INSERT INTO alert_outbox(incident_id,channel_id,user_id,kind,dedupe_key,payload) VALUES($1,$2,$3,'down',$1::uuid::text || ':' || $2::uuid::text || ':down','{}')",
        [incidentId, channelId, userId],
      );
    }
  });

  afterAll(async () => {
    await client?.close();
  });

  it("rejects a missing or malformed actor before issuing any query", () => {
    const execute = vi.fn();
    for (const actor of ["", " ", "not-a-uuid", "' OR true--", undefined, null]) {
      expect(() => createDataAccess({ execute }, actor as string)).toThrow(DataAccessError);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("filters all lists and direct object reads by the authenticated owner", async () => {
    const own = createDataAccess(db, ownerA, () => clock);
    expect((await own.listMonitors()).map((row) => row.id)).toEqual([monitorA]);
    expect((await own.listChannels()).map((row) => row.id)).toEqual([channelA]);
    expect((await own.listStatusPages()).map((row) => row.id)).toEqual([pageA]);
    expect(await own.getMonitor(monitorA)).toMatchObject({
      id: monitorA,
      name: "Monitor A",
      url: "https://a.example.invalid/",
    });
    expect(await own.getChannel(channelA)).toMatchObject({ id: channelA, label: "Channel A" });
    expect(await own.getStatusPage(pageA)).toMatchObject({ id: pageA, title: "Page A" });
    expect(await own.getIncident(incidentA)).toMatchObject({ id: incidentA, cause: "timeout" });
    expect(await own.getMonitor(monitorB)).toBeNull();
    expect(await own.getChannel(channelB)).toBeNull();
    expect(await own.getIncident(incidentB)).toBeNull();
    expect(await own.getStatusPage(pageB)).toBeNull();
    expect(await own.getMonitor(missing)).toBeNull();
    expect(await own.getChannel(missing)).toBeNull();
    expect(await own.getIncident(missing)).toBeNull();
    expect(await own.getStatusPage(missing)).toBeNull();
    expect(
      (await createDataAccess(db, ownerB, () => clock).listMonitors()).map((row) => row.id),
    ).toEqual([monitorB]);
  });

  it.each(["monitor", "channel", "page"] as const)(
    "blocks cross-user %s edits while allowing an owned edit",
    async (resource) => {
      const a = createDataAccess(db, ownerA, () => clock);
      const b = createDataAccess(db, ownerB, () => clock);
      if (resource === "monitor") {
        expect(await a.renameMonitor(monitorB, "Foreign edit")).toBe(false);
        expect((await b.getMonitor(monitorB))?.name).toBe("Monitor B");
        expect(await a.renameMonitor(monitorA, "Owned edit")).toBe(true);
        expect((await a.getMonitor(monitorA))?.name).toBe("Owned edit");
      } else if (resource === "channel") {
        expect(await a.renameChannel(channelB, "Foreign edit")).toBe(false);
        expect((await b.getChannel(channelB))?.label).toBe("Channel B");
        expect(await a.renameChannel(channelA, "Owned edit")).toBe(true);
        expect((await a.getChannel(channelA))?.label).toBe("Owned edit");
      } else {
        expect(await a.renameStatusPage(pageB, "Foreign edit")).toBe(false);
        expect((await b.getStatusPage(pageB))?.title).toBe("Page B");
        expect(await a.renameStatusPage(pageA, "Owned edit")).toBe(true);
        expect((await a.getStatusPage(pageA))?.title).toBe("Owned edit");
      }
    },
  );

  it.each(["monitor", "channel", "incident", "page"] as const)(
    "blocks cross-user %s deletion while allowing owned deletion",
    async (resource) => {
      const a = createDataAccess(db, ownerA, () => clock);
      const b = createDataAccess(db, ownerB, () => clock);
      if (resource === "monitor") {
        expect(await a.deleteMonitor(monitorB)).toBe(false);
        expect(await b.getMonitor(monitorB)).not.toBeNull();
        expect(await a.deleteMonitor(monitorA)).toBe(true);
        expect(await a.getMonitor(monitorA)).toBeNull();
      } else if (resource === "channel") {
        expect(await a.deleteChannel(channelB)).toBe(false);
        expect(await b.getChannel(channelB)).not.toBeNull();
        expect(await a.deleteChannel(channelA)).toBe(true);
        expect(await a.getChannel(channelA)).toBeNull();
      } else if (resource === "incident") {
        expect(await a.deleteIncident(incidentB)).toBe(false);
        expect(await b.getIncident(incidentB)).not.toBeNull();
        expect(await a.deleteIncident(incidentA)).toBe(true);
        expect(await a.getIncident(incidentA)).toBeNull();
      } else {
        expect(await a.deleteStatusPage(pageB)).toBe(false);
        expect(await b.getStatusPage(pageB)).not.toBeNull();
        expect(await a.deleteStatusPage(pageA)).toBe(true);
        expect(await a.getStatusPage(pageA)).toBeNull();
      }
    },
  );

  it("filters child histories and associations through owned parent rows", async () => {
    const a = createDataAccess(db, ownerA, () => clock);
    for (const list of [a.listChecks, a.listIncidents, a.listMonitorChannels]) {
      expect(await list(monitorA)).toHaveLength(1);
      expect(await list(monitorB)).toEqual([]);
      expect(await list(missing)).toEqual([]);
    }
    expect(await a.listPageMonitors(pageA)).toHaveLength(1);
    expect(await a.listPageMonitors(pageB)).toEqual([]);
    expect(await a.listAlertOutbox(incidentA)).toHaveLength(1);
    expect(await a.listAlertOutbox(incidentB)).toEqual([]);
  });

  it("restricts monitor summaries and insights to the owner and masks the target URL", async () => {
    await client.query("UPDATE monitors SET url=$2 WHERE id=$1", [
      monitorA,
      "https://a.example.invalid/status?token=fixture-private#private-fragment",
    ]);
    const access = createDataAccess(db, ownerA, () => clock);
    const summaries = await access.listMonitorSummaries();
    expect(summaries).toMatchObject([
      {
        id: monitorA,
        url: "https://a.example.invalid/status?…",
        averageMs: 42,
        openIncidentStartedAt: clock,
      },
    ]);
    const detail = await access.getMonitorInsights(monitorA, "24h");
    expect(detail).toMatchObject({
      monitor: { id: monitorA, url: "https://a.example.invalid/status?…" },
      openIncidentStartedAt: clock,
    });
    const output = JSON.stringify({ summaries, detail });
    expect(output).not.toMatch(/fixture-private|private-fragment|ownerId|userId/);
    expect(await access.getMonitorInsights(monitorB, "24h")).toBeNull();
    expect(await access.getMonitorInsights(missing, "24h")).toBeNull();
    expect((await createDataAccess(db, ownerB, () => clock).listMonitorSummaries()).map((row) => row.id))
      .toEqual([monitorB]);
  });

  it("rejects malformed insight inputs before issuing a query", async () => {
    const execute = vi.fn();
    const access = createDataAccess({ execute }, ownerA, () => clock);
    await expect(access.getMonitorInsights("' OR true--", "24h")).rejects.toThrow(DataAccessError);
    await expect(access.getMonitorInsights(monitorA, "toString" as MonitorRange))
      .rejects.toThrow(DataAccessError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("includes all checks in the range and filters future and foreign samples", async () => {
    await client.query(
      "UPDATE monitors SET created_at=$2::timestamptz-interval '24 hours' WHERE id=$1",
      [monitorA, clock],
    );
    await client.query(
      `INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms)
       SELECT md5('metrics-check-' || n)::uuid,$1,1,$2::timestamptz-n*interval '5 minutes',true,200,110
       FROM generate_series(1,120) AS n`,
      [monitorA, clock],
    );
    await client.query(
      `INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms)
       VALUES (gen_random_uuid(),$1,1,$3::timestamptz+interval '1 second',true,200,900),
              (gen_random_uuid(),$2,1,$3,true,200,900)`,
      [monitorA, monitorB, clock],
    );
    const access = createDataAccess(db, ownerA, () => clock);
    expect(await access.listMonitorSummaries()).toMatchObject([{ averageMs: (120 * 110 + 42) / 121 }]);
    expect((await access.getMonitorInsights(monitorA, "24h"))?.insights.latency).toMatchObject({
      samples: 121,
      averageMs: (120 * 110 + 42) / 121,
    });
  });

  it("reads the pre-window check, inherited pause and overlapping incident for summaries", async () => {
    await client.query(
      "UPDATE monitors SET created_at=$2::timestamptz-interval '27 hours' WHERE id=$1",
      [monitorA, clock],
    );
    await client.query(
      `INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms)
       SELECT md5('boundary-check-' || n)::uuid,$1::uuid,1,$2::timestamptz-n*interval '1 minute',true,200,110
       FROM generate_series(1,1436,5) AS n
       UNION ALL SELECT gen_random_uuid(),$1::uuid,1,$2::timestamptz-interval '24 hours 4 minutes',true,200,110`,
      [monitorA, clock],
    );
    const access = createDataAccess(db, ownerA, () => clock);
    const [beforeIncident] = await access.listMonitorSummaries();
    expect(beforeIncident.availability).toEqual({ coverage: 1, percent: 100 });

    await client.query(
      `UPDATE incidents SET started_at=$2::timestamptz-interval '25 hours',
          confirmed_at=$2::timestamptz-interval '25 hours',
          resolved_at=$2::timestamptz-interval '23 hours',resolved_reason='recovered',
          resolved_confirmed_at=$2::timestamptz-interval '23 hours'
       WHERE id=$1`,
      [incidentA, clock],
    );
    const [withIncident] = await access.listMonitorSummaries();
    expect(withIncident.availability.coverage).toBe(1);
    expect(withIncident.availability.percent).toBeCloseTo(100 * (23 / 24));

    await client.query(
      `INSERT INTO monitor_events(monitor_id,kind,at)
       VALUES ($1,'blocked',$2::timestamptz-interval '25 hours'),
              ($1,'resumed',$2::timestamptz-interval '23 hours')`,
      [monitorA, clock],
    );
    const [afterPause] = await access.listMonitorSummaries();
    expect(afterPause.availability.coverage).toBeCloseTo(23 / 24);
    expect(afterPause.availability.percent).toBe(100);
  });

  it("scopes relationship edits to the owner in the modifying statement", async () => {
    const a = createDataAccess(db, ownerA, () => clock);
    const b = createDataAccess(db, ownerB, () => clock);
    expect(await a.setPageMonitorVisibility(pageB, monitorB, true)).toBe(false);
    expect(await a.setPageMonitorVisibility(pageA, monitorB, true)).toBe(false);
    expect(await a.unlinkPageMonitor(pageB, monitorB)).toBe(false);
    expect(await a.unlinkMonitorChannel(monitorB, channelB)).toBe(false);
    expect(await a.unlinkMonitorChannel(monitorA, channelB)).toBe(false);
    expect((await b.listPageMonitors(pageB))[0]?.showUrl).toBe(false);
    expect(await b.listMonitorChannels(monitorB)).toHaveLength(1);
    expect(await a.setPageMonitorVisibility(pageA, monitorA, true)).toBe(true);
    expect((await a.listPageMonitors(pageA))[0]?.showUrl).toBe(true);
    expect(await a.unlinkPageMonitor(pageA, monitorA)).toBe(true);
    expect(await a.listPageMonitors(pageA)).toEqual([]);
    expect(await a.unlinkMonitorChannel(monitorA, channelA)).toBe(true);
    expect(await a.listMonitorChannels(monitorA)).toEqual([]);
  });

  it("returns explicit DTOs with no encrypted config, account tokens or owner IDs", async () => {
    const a = createDataAccess(db, ownerA, () => clock);
    const channel = await a.getChannel(channelA);
    expect(Object.keys(channel ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "isVerified",
      "label",
      "type",
    ]);
    expect((await a.listMonitorChannels(monitorA))[0]).toMatchObject({
      id: channelA,
      label: "Channel A",
    });
    const data = JSON.stringify([
      await a.listChannels(),
      await a.listMonitorChannels(monitorA),
      await a.listAlertOutbox(incidentA),
    ]);
    for (const secretField of [
      "config_enc",
      "configEnc",
      "fixture-envelope",
      "accessToken",
      "refreshToken",
      "password",
      "userId",
      "user_id",
    ]) {
      expect(data).not.toContain(secretField);
    }
  });

  it("rejects malformed object IDs, invalid paging and non-text edits generically", async () => {
    const a = createDataAccess(db, ownerA, () => clock);
    await expect(a.getMonitor("' OR true--")).rejects.toThrow(DataAccessError);
    await expect(
      a.renameMonitor(monitorA, { userId: ownerB } as unknown as string),
    ).rejects.toThrow(DataAccessError);
    await expect(a.listMonitors({ limit: 0 })).rejects.toThrow(DataAccessError);
    await expect(a.listMonitors({ limit: 101 })).rejects.toThrow(DataAccessError);
    await expect(a.listMonitors({ offset: -1 })).rejects.toThrow(DataAccessError);
    expect((await a.getMonitor(monitorA))?.name).toBe("Monitor A");
  });

  it("uses stable bounded pagination without widening ownership", async () => {
    await client.query(
      "INSERT INTO monitors(user_id,name,url,host) VALUES($1,'Monitor A','https://second.example.invalid','second.example.invalid')",
      [ownerA],
    );
    const a = createDataAccess(db, ownerA, () => clock);
    const first = await a.listMonitors({ limit: 1 });
    const second = await a.listMonitors({ limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect([...first, ...second].every((row) => row.id !== monitorB)).toBe(true);
    const all = await a.listMonitors();
    expect(all.map((row) => row.id)).toEqual([...first, ...second].map((row) => row.id));
  });

  it("does not surface raw database exceptions or credential-like values", async () => {
    const access = createDataAccess(
      {
        execute: async () => {
          throw new Error("postgresql://fixture:do-not-leak@private.example.invalid/db");
        },
      },
      ownerA,
    );
    await expect(access.listMonitors()).rejects.toThrow("Data access failed.");
    try {
      await access.listMonitors();
    } catch (error) {
      expect(error).toBeInstanceOf(DataAccessError);
      expect(String(error)).not.toContain("do-not-leak");
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("masks query credentials in every monitor DTO and derives display-only states", async () => {
    const access = createDataAccess(db, ownerA, () => clock);
    await client.query(
      "UPDATE monitors SET url='https://a.example.invalid/health?key=fixture-private#fragment',status='up' WHERE id=$1",
      [monitorA],
    );
    expect((await access.getMonitor(monitorA))?.url).toBe("https://a.example.invalid/health?…");
    expect(JSON.stringify(await access.listMonitors())).not.toContain("fixture-private");
    expect((await access.getMonitor(monitorA))?.status).toBe("up");
    await client.query("UPDATE monitors SET failures=1 WHERE id=$1", [monitorA]);
    expect((await access.getMonitor(monitorA))?.status).toBe("confirming");
    await client.query("UPDATE monitors SET status='down',failures=0,successes=1 WHERE id=$1", [
      monitorA,
    ]);
    expect((await access.getMonitor(monitorA))?.status).toBe("confirming");
    await client.query("UPDATE monitors SET last_checked_at=$1 WHERE id=$2", [
      new Date(clock.getTime() - 901000),
      monitorA,
    ]);
    expect((await access.getMonitor(monitorA))?.status).toBe("unknown");
    await client.query(
      "UPDATE monitors SET is_paused=true,pause_reason='blocked_host' WHERE id=$1",
      [monitorA],
    );
    expect((await access.getMonitor(monitorA))?.status).toBe("blocked");
    await client.query("UPDATE monitors SET pause_reason='user' WHERE id=$1", [monitorA]);
    expect((await access.getMonitor(monitorA))?.status).toBe("paused");
    expect(access).not.toHaveProperty("resolveIncident");
    expect(access).not.toHaveProperty("listRollups");
  });

  it("shows first-result Pending until ten minutes, then Unknown", async () => {
    await client.query(
      "UPDATE monitors SET status='up',created_at=$1,last_checked_at=NULL WHERE id=$2",
      [clock, monitorA],
    );
    expect((await createDataAccess(db, ownerA, () => clock).getMonitor(monitorA))?.status).toBe(
      "pending",
    );
    const stale = new Date(clock.getTime() + 600000);
    expect((await createDataAccess(db, ownerA, () => stale).getMonitor(monitorA))?.status).toBe(
      "unknown",
    );
  });

  it("preserves a visibility edit when replacing the same owned page links concurrently", async () => {
    const access = createDataAccess(db, ownerA, () => clock);
    expect(
      await Promise.all([
        access.setPageMonitorVisibility(pageA, monitorA, true),
        access.replacePageMonitors(pageA, [monitorA]),
      ]),
    ).toEqual([true, true]);
    expect(await access.listPageMonitors(pageA)).toMatchObject([
      { monitorId: monitorA, showUrl: true },
    ]);
    expect(await access.setPageMonitorVisibility(pageA, monitorB, true)).toBe(false);
    expect(await access.setPageMonitorVisibility(pageB, monitorA, true)).toBe(false);
  });

  it("attaches only owned channels and performs replacement atomically", async () => {
    const access = createDataAccess(db, ownerA, () => clock);
    expect(await access.attachMonitorChannel(monitorB, channelA)).toBe(false);
    expect(await access.attachMonitorChannel(monitorA, channelB)).toBe(false);
    expect(await access.replaceMonitorChannels(monitorB, [channelA])).toBe(false);
    expect(await access.replaceMonitorChannels(monitorA, [channelB])).toBe(false);
    expect((await access.listMonitorChannels(monitorA)).map((channel) => channel.id)).toEqual([
      channelA,
    ]);
    expect(await access.replaceMonitorChannels(monitorA, [])).toBe(true);
    expect(await access.listMonitorChannels(monitorA)).toEqual([]);
    expect(await access.attachMonitorChannel(monitorA, channelA)).toBe(true);
    expect(await access.attachMonitorChannel(monitorA, channelA)).toBe(true);
    expect(await access.listMonitorChannels(monitorA)).toHaveLength(1);
    expect(await access.replaceMonitorChannels(monitorA, [channelA])).toBe(true);
    expect(await access.attachMonitorChannel(monitorA.toUpperCase(), channelA.toUpperCase())).toBe(
      true,
    );
    await expect(
      access.replaceMonitorChannels(monitorA, [channelA, channelA.toUpperCase()]),
    ).rejects.toThrow(DataAccessError);
  });

  it("attaches and replaces only owned page monitors while preserving visibility on retained links", async () => {
    const access = createDataAccess(db, ownerA, () => clock);
    expect(await access.attachPageMonitor(pageB, monitorA)).toBe(false);
    expect(await access.attachPageMonitor(pageA, monitorB)).toBe(false);
    expect(await access.replacePageMonitors(pageB, [monitorA])).toBe(false);
    expect(await access.replacePageMonitors(pageA, [monitorB])).toBe(false);
    expect((await access.listPageMonitors(pageA)).map((monitor) => monitor.monitorId)).toEqual([
      monitorA,
    ]);
    expect(await access.setPageMonitorVisibility(pageA, monitorA, true)).toBe(true);
    expect(await access.replacePageMonitors(pageA, [monitorA])).toBe(true);
    expect((await access.listPageMonitors(pageA))[0]?.showUrl).toBe(true);
    expect(await access.replacePageMonitors(pageA.toUpperCase(), [monitorA.toUpperCase()])).toBe(
      true,
    );
    expect((await access.listPageMonitors(pageA))[0]?.showUrl).toBe(true);
    expect(await access.replacePageMonitors(pageA, [])).toBe(true);
    expect(await access.attachPageMonitor(pageA, monitorA)).toBe(true);
    expect((await access.listPageMonitors(pageA))[0]?.showUrl).toBe(false);
  });

  it("prevents foreign publication and publication without any monitor", async () => {
    const access = createDataAccess(db, ownerA, () => clock);
    expect(await access.setStatusPagePublished(pageB, true)).toBe(false);
    expect(
      (await createDataAccess(db, ownerB, () => clock).getStatusPage(pageB))?.isPublished,
    ).toBe(false);
    expect(await access.setStatusPagePublished(pageA, true)).toBe(true);
    expect((await access.getStatusPage(pageA))?.isPublished).toBe(true);
    expect(await access.setStatusPagePublished(pageA, false)).toBe(true);
    expect(await access.replacePageMonitors(pageA, [])).toBe(true);
    expect(await access.setStatusPagePublished(pageA, true)).toBe(false);
  });

  it("bounds page associations atomically during competing requests", async () => {
    const access = createDataAccess(db, ownerA, () => clock);
    // Administrative fixtures isolate the page cap independently of monitor admission.
    const ids: string[] = [monitorA];
    for (let index = 0; index < 10; index++) {
      const added = await client.query<{ id: string }>(
        "INSERT INTO monitors(user_id,name,url,host) VALUES($1,'Fixture','https://fixture.example.invalid','fixture.example.invalid') RETURNING id",
        [ownerA],
      );
      ids.push(added.rows[0].id);
    }
    expect(await access.replacePageMonitors(pageA, ids.slice(0, 9))).toBe(true);
    const attempts = await Promise.allSettled(
      ids.slice(9).map((id) => access.attachPageMonitor(pageA, id)),
    );
    expect(attempts.filter((result) => result.status === "fulfilled" && result.value)).toHaveLength(
      1,
    );
    expect(attempts.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await access.listPageMonitors(pageA)).toHaveLength(10);
    await expect(access.replacePageMonitors(pageA, ids)).rejects.toThrow(DataAccessError);
    expect(await access.listPageMonitors(pageA)).toHaveLength(10);
  });
});
