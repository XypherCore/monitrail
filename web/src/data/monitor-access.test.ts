import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorFields } from "../monitors/input.ts";
import { MONITOR_LIMITS } from "../monitors/limits.ts";
import { createDataAccess } from "./access.ts";
import { createMonitorAccess } from "./monitor-access.ts";

const appUrl = "http://localhost:3000";
const ownerA = "10000000-0000-4000-8000-000000000001";
const ownerB = "10000000-0000-4000-8000-000000000002";
const storedTarget = "https://check.example.invalid/status?key=private-value";
const editFields = { name: "Fixture", intervalSeconds: 300, expectedStatus: "2xx" } as const;
const createFields = (url = storedTarget): MonitorFields => ({ ...editFields, url });
const resolvePublic = async (_host: string) => [{ address: "93.184.216.34", family: 4 }];

describe("Phase 4 owner-bound monitor changes", () => {
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
    await client.exec("TRUNCATE users, blocked_hosts, rate_limits CASCADE");
    await client.query("INSERT INTO users(id,name) VALUES ($1,'A'),($2,'B')", [ownerA, ownerB]);
  });
  afterAll(async () => {
    await client?.close();
  });

  function access(owner = ownerA, resolve = resolvePublic) {
    return createMonitorAccess(db, owner, appUrl, { resolve });
  }
  async function seed(owner: string, host: string, paused = false) {
    const id = randomUUID();
    await client.query(
      "INSERT INTO monitors(id,user_id,name,url,host,is_paused,pause_reason) VALUES ($1,$2,'Fixture',$3,$4,$5,$6)",
      [id, owner, `https://${host}/`, host, paused, paused ? "user" : null],
    );
    return id;
  }
  async function record(id: string) {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT *, next_check_at::text AS due FROM monitors WHERE id=$1",
      [id],
    );
    return rows[0];
  }
  async function events(id: string) {
    const { rows } = await client.query<{ kind: string }>(
      "SELECT kind FROM monitor_events WHERE monitor_id=$1 ORDER BY at",
      [id],
    );
    return rows.map((row) => row.kind);
  }
  async function markDown(id: string) {
    await client.query(
      `UPDATE monitors SET status='down', failures=2, successes=1, streak_started_at=now(),
         streak_first_error='timeout', next_check_at=now()+interval '2 minutes', last_checked_at=now(),
         lease_id=gen_random_uuid(),lease_until=now()+interval '2 minutes',created_at=now()-interval '1 day'
       WHERE id=$1`,
      [id],
    );
    await client.query(
      "INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause) VALUES($1,$2,now(),now(),'timeout')",
      [id, ownerA],
    );
  }
  async function incident(id: string) {
    const { rows } = await client.query<Record<string, unknown>>(
      "SELECT resolved_at, resolved_confirmed_at, resolved_reason FROM incidents WHERE monitor_id=$1",
      [id],
    );
    return rows[0];
  }
  async function total(table: "monitors" | "alert_outbox") {
    const { rows } = await client.query<{ total: number }>(`SELECT count(*)::int AS total FROM ${table}`);
    return rows[0].total;
  }

  it("stores a canonical guarded target and returns only its ID on creation", async () => {
    const resolve = vi.fn(resolvePublic);
    const created = await access(ownerA, resolve).createMonitor(
      createFields("https://Check.EXAMPLE.invalid./status?key=private-value#omit"),
    );
    expect(Object.keys(created)).toEqual(["id"]);
    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve.mock.calls[0]?.[0]).toBe("check.example.invalid");
    const saved = await record(created.id);
    expect(saved).toMatchObject({
      url: storedTarget,
      host: "check.example.invalid",
      status: "pending",
      config_rev: 1,
      last_checked_at: null,
      failures: 0,
      successes: 0,
    });
    expect(saved.dns_checked_at).toBeInstanceOf(Date);
    expect((saved.next_check_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
    expect(await events(created.id)).toEqual(["created"]);
    expect(await createDataAccess(db, ownerA).getMonitor(created.id)).toMatchObject({
      status: "pending",
      url: "https://check.example.invalid/status?…",
    });
  });

  it.each(["user", "global", "host"] as const)("enforces the %s cap on overlapping creates", async (cap) => {
    if (cap === "global") {
      for (let i = 0; i < MONITOR_LIMITS.global - 1; i++) {
        const owner = randomUUID();
        await client.query("INSERT INTO users(id,name) VALUES($1,'Fixture')", [owner]);
        await seed(owner, `occupied-${i}.example.invalid`, true);
      }
    } else {
      for (let i = 0; i < MONITOR_LIMITS[cap] - 1; i++) {
        const owner = cap === "host" && i % 2 ? ownerB : ownerA;
        const host = cap === "host" ? "target.example.invalid" : `occupied-${i}.example.invalid`;
        await seed(owner, host, true);
      }
    }
    const results = await Promise.allSettled([
      access().createMonitor(createFields("https://TARGET.example.invalid./a")),
      access(cap === "user" ? ownerA : ownerB).createMonitor(
        createFields(cap === "host" ? "https://target.example.invalid:8443/b" : "https://other.example.invalid/b"),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: `${cap}_limit` },
    });
    expect(await total("monitors")).toBe(MONITOR_LIMITS[cap]);
  });

  it("counts a cross-host edit toward the destination host cap", async () => {
    const id = await seed(ownerA, "source.example.invalid");
    for (let i = 0; i < MONITOR_LIMITS.host; i++) await seed(ownerB, "target.example.invalid", true);
    await expect(access().editMonitor(id, createFields("https://TARGET.example.invalid./new")))
      .rejects.toMatchObject({ code: "host_limit" });
    expect(await record(id)).toMatchObject({ host: "source.example.invalid", config_rev: 1 });
    expect(await events(id)).toEqual([]);
  });

  it("allows a same-host URL edit at the host cap", async () => {
    const host = "target.example.invalid";
    const id = await seed(ownerA, host);
    for (let i = 1; i < MONITOR_LIMITS.host; i++) await seed(ownerB, host, true);
    expect(await access().editMonitor(id, createFields(`https://${host}:8443/new`))).toBe(true);
    expect(await record(id)).toMatchObject({ host, config_rev: 2 });
  });

  it("spends validation allowance before DNS and rejects every attempt beyond a rolling hour cap", async () => {
    const resolve = vi.fn(async () => { throw new Error("private resolver details"); });
    const staleAt = "2000-01-01T00:00:00.000Z";
    await client.query("INSERT INTO rate_limits(key,window_start,count) VALUES($1,$2,$3)", [
      `monitor-url:${ownerA}`,
      staleAt,
      MONITOR_LIMITS.validations,
    ]);
    const operations = Array.from({ length: MONITOR_LIMITS.validations + 2 }, () =>
      access(ownerA, resolve).createMonitor(createFields()),
    );
    const results = await Promise.allSettled(operations);
    expect(resolve).toHaveBeenCalledTimes(MONITOR_LIMITS.validations);
    expect(results.filter((result) => result.status === "rejected" && result.reason.code === "dns"))
      .toHaveLength(MONITOR_LIMITS.validations);
    const throttled = results.filter((result) => result.status === "rejected" && result.reason.code === "validation_limit");
    expect(throttled).toHaveLength(2);
    for (const result of throttled) {
      expect(result).toMatchObject({ reason: { retryAfterSeconds: expect.any(Number) } });
    }
    expect(await total("monitors")).toBe(0);
  });

  it("blocks label-boundary descendants and catches a block added during validation", async () => {
    await client.query(
      "INSERT INTO blocked_hosts(host,include_subdomains,reason) VALUES ('blocked.invalid',true,'fixture')",
    );
    const resolve = vi.fn(resolvePublic);
    await expect(access(ownerA, resolve).createMonitor(createFields("https://deep.blocked.invalid/")))
      .rejects.toMatchObject({ code: "blocked" });
    expect(resolve).not.toHaveBeenCalled();
    await access().createMonitor(createFields("https://notblocked.invalid/"));
    const resolveAndBlock = async (host: string) => {
      await client.query(
        "INSERT INTO blocked_hosts(host,include_subdomains,reason) VALUES ('check.example.invalid',false,'fixture')",
      );
      return resolvePublic(host);
    };
    await expect(access(ownerA, resolveAndBlock).createMonitor(createFields()))
      .rejects.toMatchObject({ code: "blocked" });
    expect(await total("monitors")).toBe(1);
  });

  it("fails closed on a private address without creating any monitor", async () => {
    await expect(access(ownerA, async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]).createMonitor(createFields())).rejects.toMatchObject({ code: "blocked" });
    expect(await total("monitors")).toBe(0);
  });

  it("protects foreign edits and pause/resume/delete without resolving the URL", async () => {
    const id = await seed(ownerB, "foreign.example.invalid");
    const resolve = vi.fn(resolvePublic);
    const ours = access(ownerA, resolve);
    expect(await ours.editMonitor(id, createFields())).toBe(false);
    expect(await ours.editMonitor(id, editFields)).toBe(false);
    expect(await ours.setMonitorPaused(id, true)).toBe(false);
    expect(await ours.setMonitorPaused(id, false)).toBe(false);
    expect(await ours.deleteMonitor(id)).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
    expect(await record(id)).toMatchObject({ host: "foreign.example.invalid", is_paused: false });
  });

  it("does not resurrect a monitor deleted while its replacement URL resolves", async () => {
    const id = await seed(ownerA, "old.example.invalid");
    const resolveAndDelete = async (host: string) => {
      expect(await access().deleteMonitor(id)).toBe(true);
      return resolvePublic(host);
    };
    expect(await access(ownerA, resolveAndDelete).editMonitor(id, createFields())).toBe(false);
    expect(await total("monitors")).toBe(0);
    expect(await events(id)).toEqual([]);
  });

  it("keeps the URL, live lease, streak, status and next due time on an interval-only edit", async () => {
    const { id } = await access().createMonitor(createFields());
    await markDown(id);
    const before = await record(id);
    const resolve = vi.fn(resolvePublic);
    expect(await access(ownerA, resolve).editMonitor(id, { ...editFields, intervalSeconds: 600 })).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    const after = await record(id);
    expect(after).toEqual({ ...before, interval_seconds: 600 });
    expect(after.url).toBe(storedTarget);
    expect(await incident(id)).toMatchObject({ resolved_at: null, resolved_reason: null });
    expect(await events(id)).toEqual(["created"]);
  });

  it.each(["url", "expected"] as const)(
    "closes an incident and resets the observation when the %s changes",
    async (change) => {
      const { id } = await access().createMonitor(createFields());
      await markDown(id);
      const fields = change === "url"
        ? createFields("https://new.example.invalid/")
        : { ...editFields, expectedStatus: "2xx_3xx" as const };
      expect(await access().editMonitor(id, fields)).toBe(true);
      const saved = await record(id);
      expect(saved).toMatchObject({
        config_rev: 2,
        status: "pending",
        failures: 0,
        successes: 0,
        streak_started_at: null,
        streak_first_error: null,
        lease_id: null,
        lease_until: null,
        last_checked_at: null,
      });
      expect((saved.next_check_at as Date).getTime()).toBeLessThanOrEqual(Date.now());
      expect(await incident(id)).toMatchObject({ resolved_reason: "config_changed", resolved_confirmed_at: null });
      expect(await events(id)).toEqual(["created", "config_changed"]);
      expect(await total("alert_outbox")).toBe(0);
      expect((await createDataAccess(db, ownerA).getMonitor(id))?.status).toBe("pending");
      const later = createDataAccess(db, ownerA, () => new Date(Date.now() + 10 * 60 * 1000 + 1));
      expect((await later.getMonitor(id))?.status).toBe("unknown");
      expect(await access().editMonitor(id, fields)).toBe(true);
      expect((await record(id)).config_rev).toBe(2);
    },
  );

  it("pauses and resumes transactionally, preserves historical checks and makes retries harmless", async () => {
    const { id } = await access().createMonitor(createFields());
    await markDown(id);
    await client.query(
      "INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms) VALUES(gen_random_uuid(),$1,1,now(),true,200,1)",
      [id],
    );
    expect(await access().setMonitorPaused(id, true)).toBe(true);
    expect(await access().setMonitorPaused(id, true)).toBe(true);
    expect(await record(id)).toMatchObject({
      config_rev: 2, is_paused: true, pause_reason: "user", failures: 0, successes: 0,
      lease_id: null, lease_until: null, streak_started_at: null, streak_first_error: null,
    });
    expect(await incident(id)).toMatchObject({ resolved_reason: "paused", resolved_confirmed_at: null });
    expect(await access().setMonitorPaused(id, false)).toBe(true);
    expect(await access().setMonitorPaused(id, false)).toBe(true);
    expect(await record(id)).toMatchObject({
      config_rev: 3, is_paused: false, pause_reason: null, status: "pending", last_checked_at: null,
    });
    expect((await createDataAccess(db, ownerA).getMonitor(id))?.status).toBe("pending");
    expect(await events(id)).toEqual(["created", "paused", "resumed"]);
    expect(await total("alert_outbox")).toBe(0);
    expect((await client.query("SELECT id FROM checks WHERE monitor_id=$1", [id])).rows).toHaveLength(1);
    expect(await access().deleteMonitor(id)).toBe(true);
    expect(await access().deleteMonitor(id)).toBe(false);
    expect((await client.query("SELECT id FROM checks WHERE monitor_id=$1", [id])).rows).toHaveLength(0);
  });

  it("requires a blocked monitor to pass URL validation and resume separately", async () => {
    const { id } = await access().createMonitor(createFields());
    await client.query(
      "UPDATE monitors SET is_paused=true,pause_reason='blocked_host' WHERE id=$1",
      [id],
    );
    const resolve = vi.fn(resolvePublic);
    const owner = access(ownerA, resolve);
    await expect(owner.setMonitorPaused(id, false)).rejects.toMatchObject({ code: "blocked_resume" });
    expect(resolve).not.toHaveBeenCalled();
    await expect(access(ownerA, async () => [{ address: "127.0.0.1", family: 4 }])
      .editMonitor(id, createFields())).rejects.toMatchObject({ code: "blocked" });
    expect(await record(id)).toMatchObject({ is_paused: true, pause_reason: "blocked_host" });
    expect(await owner.editMonitor(id, editFields)).toBe(true);
    expect(await record(id)).toMatchObject({ is_paused: true, pause_reason: "blocked_host" });
    expect(await owner.editMonitor(id, createFields())).toBe(true);
    expect(await record(id)).toMatchObject({ is_paused: true, pause_reason: "user", config_rev: 1 });
    expect(await owner.setMonitorPaused(id, false)).toBe(true);
    expect(await record(id)).toMatchObject({ is_paused: false, pause_reason: null, config_rev: 2 });
    expect(await events(id)).toEqual(["created", "resumed"]);
  });
});
