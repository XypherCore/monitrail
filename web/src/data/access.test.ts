import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  }, 30_000);

  beforeEach(async () => {
    // This database is private in-memory PostgreSQL, never DATABASE_URL.
    await client.exec("TRUNCATE users RESTART IDENTITY CASCADE");
    await client.query("INSERT INTO users(id,email,name) VALUES($1,'owner-a@example.invalid','Fixture A'),($2,'owner-b@example.invalid','Fixture B')", [ownerA, ownerB]);
    await client.query("INSERT INTO monitors(id,user_id,name,url) VALUES($1,$2,'Monitor A','https://a.example.invalid'),($3,$4,'Monitor B','https://b.example.invalid')", [monitorA, ownerA, monitorB, ownerB]);
    // Dummy bytes exercise redaction/ownership, not encryption implementation.
    await client.query("INSERT INTO alert_channels(id,user_id,type,label,config_encrypted) VALUES($1,$2,'webhook','Channel A',decode('deadbeef','hex')),($3,$4,'webhook','Channel B',decode('deadbeef','hex'))", [channelA, ownerA, channelB, ownerB]);
    await client.query("INSERT INTO status_pages(id,user_id,slug,title) VALUES($1,$2,'owner-a','Page A'),($3,$4,'owner-b','Page B')", [pageA, ownerA, pageB, ownerB]);
    await client.query("INSERT INTO incidents(id,monitor_id,user_id,started_at,cause) VALUES($1,$2,$3,$4,'timeout'),($5,$6,$7,$4,'dns')", [incidentA, monitorA, ownerA, clock, incidentB, monitorB, ownerB]);
    for (const [userId, monitorId, channelId, pageId, incidentId] of [[ownerA, monitorA, channelA, pageA, incidentA], [ownerB, monitorB, channelB, pageB, incidentB]]) {
      await client.query("INSERT INTO checks(monitor_id,checked_at,ok,status_code,response_ms) VALUES($1,$2,true,200,42)", [monitorId, clock]);
      await client.query("INSERT INTO check_rollups_hourly(monitor_id,hour,total,failed,avg_ms,p95_ms,max_ms) VALUES($1,$2,1,0,42,42,42)", [monitorId, clock]);
      await client.query("INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES($1,$2,$3)", [userId, monitorId, channelId]);
      await client.query("INSERT INTO status_page_monitors(user_id,status_page_id,monitor_id) VALUES($1,$2,$3)", [userId, pageId, monitorId]);
      await client.query("INSERT INTO alert_events(incident_id,channel_id,user_id,kind) VALUES($1,$2,$3,'down')", [incidentId, channelId, userId]);
    }
  });

  afterAll(async () => { await client?.close(); });

  it("rejects a missing or malformed actor before issuing any query", () => {
    const execute = vi.fn();
    for (const actor of ["", " ", "not-a-uuid", "' OR true--", undefined, null]) {
      expect(() => createDataAccess({ execute }, actor as string)).toThrow(DataAccessError);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("filters all lists and direct object reads by the authenticated owner", async () => {
    const own = createDataAccess(db, ownerA);
    expect((await own.listMonitors()).map(row => row.id)).toEqual([monitorA]);
    expect((await own.listChannels()).map(row => row.id)).toEqual([channelA]);
    expect((await own.listStatusPages()).map(row => row.id)).toEqual([pageA]);
    expect(await own.getMonitor(monitorA)).toMatchObject({ id: monitorA, name: "Monitor A", url: "https://a.example.invalid" });
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
    expect((await createDataAccess(db, ownerB).listMonitors()).map(row => row.id)).toEqual([monitorB]);
  });

  it.each(["monitor", "channel", "incident", "page"] as const)("blocks cross-user %s edits while allowing an owned edit", async resource => {
    const a = createDataAccess(db, ownerA);
    const b = createDataAccess(db, ownerB);
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
    } else if (resource === "incident") {
      const resolvedAt = new Date(clock.getTime() + 60_000);
      expect(await a.resolveIncident(incidentB, resolvedAt)).toBe(false);
      expect((await b.getIncident(incidentB))?.resolvedAt).toBeNull();
      expect(await a.resolveIncident(incidentA, resolvedAt)).toBe(true);
      expect((await a.getIncident(incidentA))?.resolvedAt).toEqual(resolvedAt);
    } else {
      expect(await a.renameStatusPage(pageB, "Foreign edit")).toBe(false);
      expect((await b.getStatusPage(pageB))?.title).toBe("Page B");
      expect(await a.renameStatusPage(pageA, "Owned edit")).toBe(true);
      expect((await a.getStatusPage(pageA))?.title).toBe("Owned edit");
    }
  });

  it.each(["monitor", "channel", "incident", "page"] as const)("blocks cross-user %s deletion while allowing owned deletion", async resource => {
    const a = createDataAccess(db, ownerA);
    const b = createDataAccess(db, ownerB);
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
  });

  it("filters child histories and associations through owned parent rows", async () => {
    const a = createDataAccess(db, ownerA);
    for (const list of [a.listChecks, a.listRollups, a.listIncidents, a.listMonitorChannels]) {
      expect(await list(monitorA)).toHaveLength(1);
      expect(await list(monitorB)).toEqual([]);
      expect(await list(missing)).toEqual([]);
    }
    expect(await a.listPageMonitors(pageA)).toHaveLength(1);
    expect(await a.listPageMonitors(pageB)).toEqual([]);
    expect(await a.listAlertEvents(incidentA)).toHaveLength(1);
    expect(await a.listAlertEvents(incidentB)).toEqual([]);
  });

  it("scopes relationship edits to the owner in the modifying statement", async () => {
    const a = createDataAccess(db, ownerA);
    const b = createDataAccess(db, ownerB);
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
    const a = createDataAccess(db, ownerA);
    const channel = await a.getChannel(channelA);
    expect(Object.keys(channel ?? {}).sort()).toEqual(["createdAt", "id", "isVerified", "label", "type"]);
    expect((await a.listMonitorChannels(monitorA))[0]).toMatchObject({ id: channelA, label: "Channel A" });
    const data = JSON.stringify([await a.listChannels(), await a.listMonitorChannels(monitorA), await a.listAlertEvents(incidentA)]);
    for (const secretField of ["config_encrypted", "configEncrypted", "deadbeef", "accessToken", "refreshToken", "password", "userId", "user_id"]) {
      expect(data).not.toContain(secretField);
    }
  });

  it("rejects malformed object IDs, invalid paging and non-text edits generically", async () => {
    const a = createDataAccess(db, ownerA);
    await expect(a.getMonitor("' OR true--")).rejects.toThrow(DataAccessError);
    await expect(a.renameMonitor(monitorA, { userId: ownerB } as unknown as string)).rejects.toThrow(DataAccessError);
    await expect(a.listMonitors({ limit: 0 })).rejects.toThrow(DataAccessError);
    await expect(a.listMonitors({ limit: 101 })).rejects.toThrow(DataAccessError);
    await expect(a.listMonitors({ offset: -1 })).rejects.toThrow(DataAccessError);
    expect((await a.getMonitor(monitorA))?.name).toBe("Monitor A");
  });

  it("uses stable bounded pagination without widening ownership", async () => {
    await client.query("INSERT INTO monitors(user_id,name,url) VALUES($1,'Monitor A','https://second.example.invalid')", [ownerA]);
    const a = createDataAccess(db, ownerA);
    const first = await a.listMonitors({ limit: 1 });
    const second = await a.listMonitors({ limit: 1, offset: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect([...first, ...second].every(row => row.id !== monitorB)).toBe(true);
    const all = await a.listMonitors();
    expect(all.map(row => row.id)).toEqual([...first, ...second].map(row => row.id));
  });

  it("does not surface raw database exceptions or credential-like values", async () => {
    const access = createDataAccess({ execute: async () => { throw new Error("postgresql://fixture:do-not-leak@private.example.invalid/db"); } }, ownerA);
    await expect(access.listMonitors()).rejects.toThrow("Data access failed.");
    try { await access.listMonitors(); }
    catch (error) {
      expect(error).toBeInstanceOf(DataAccessError);
      expect(String(error)).not.toContain("do-not-leak");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
