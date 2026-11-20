import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebGuard } from "../security/web-ssrf.ts";
import { createCheckCapabilities } from "./checks.ts";
import { createMaintenanceCapability } from "./maintenance.ts";

const owner = "a1000000-0000-4000-8000-000000000001";
let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
}, 30_000);
beforeEach(async () => {
  await client.exec("TRUNCATE users,blocked_hosts,system_heartbeat,slug_tombstones,rate_limits CASCADE");
  await client.query("INSERT INTO users(id,name) VALUES ($1,'Fixture')", [owner]);
});
afterAll(async () => { await client?.close(); });

async function monitor(host = "target.example.invalid") {
  const id = randomUUID();
  await client.query(
    "INSERT INTO monitors(id,user_id,name,url,host) VALUES ($1,$2,'Fixture',$3,$4)",
    [id, owner, `https://${host}/private?token=fixture-secret`, host],
  );
  return id;
}

function setup(resolve = vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }])) {
  const request = vi.fn(() => { throw new Error("Maintenance must never open an HTTP connection."); });
  const guard = createWebGuard({ appUrl: "https://app.example.invalid", isBlockedHost: async () => false }, { resolve, request });
  const invalidateStatus = vi.fn();
  const log = vi.fn();
  const service = createMaintenanceCapability(db, { validateMonitor: guard.validateMonitor, invalidateStatus, log });
  return { service, resolve, request, log, invalidateStatus };
}

async function domainState() {
  const state: Record<string, unknown> = {};
  for (const table of ["monitors", "checks", "check_attempts", "monitor_events", "incidents", "alert_outbox", "sessions", "rate_limits", "slug_tombstones"]) {
    state[table] = (await client.query(`SELECT row_to_json(t) AS row FROM ${table} t ORDER BY row_to_json(t)::text`)).rows;
  }
  return state;
}

describe("daily maintenance", () => {
  it("prunes only expired data and is unchanged on a second run", async () => {
    const id = await monitor();
    await client.query(`INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok)
      VALUES ($1,$2,1,now()-interval '31 days',false),($3,$2,1,now()-interval '29 days',false)`,
      [randomUUID(), id, randomUUID()]);
    await client.query(`INSERT INTO check_attempts(attempt_id,monitor_id,config_rev,expected_status,state,claimed_at,expires_at,terminal_at)
      VALUES ($1,$2,1,'2xx','done',now()-interval '3 days',now()-interval '3 days'+interval '120 seconds',now()-interval '2 days'),
      ($3,$2,1,'2xx','done',now()-interval '3 days',now()-interval '3 days'+interval '120 seconds',now()-interval '1 hour'),
      ($4,$2,1,'2xx','claimed',now()-interval '3 days',now()-interval '3 days'+interval '120 seconds',null)`,
      [randomUUID(), id, randomUUID(), randomUUID()]);
    await client.exec(`INSERT INTO rate_limits(key,window_start,count) VALUES
      ('old',now()-interval '2 days',1),('nonce:recent',now(),1);
      INSERT INTO slug_tombstones(slug,released_at) VALUES ('expired-slug',now()-interval '1 second'),('held-slug',now()+interval '29 days')`);
    await client.query(`INSERT INTO sessions(session_token,user_id,expires)
      VALUES ('old-fixture',$1,now()-interval '1 second'),('live-fixture',$1,now()+interval '1 day')`, [owner]);
    await client.query(`INSERT INTO telegram_link_codes(code_hash,user_id,expires_at)
      VALUES ('old-code',$1,now()-interval '1 second'),('live-code',$1,now()+interval '1 minute')`, [owner]);
    const { service, resolve, request, log } = setup();
    const first = await service.runMaintenance();
    expect(first).toMatchObject({ dnsRevalidated: 1, blocked: 0 });
    expect(first.removed).toBe(7);
    expect((await client.query("SELECT state FROM check_attempts")).rows).toEqual([{ state: "done" }]);
    expect((await client.query("SELECT key FROM rate_limits")).rows).toEqual([{ key: "nonce:recent" }]);
    expect((await client.query("SELECT slug FROM slug_tombstones")).rows).toEqual([{ slug: "held-slug" }]);
    const before = await domainState();
    expect(await service.runMaintenance()).toEqual({ removed: 0, dnsRevalidated: 0, blocked: 0 });
    expect(await domainState()).toEqual(before);
    expect(resolve).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/fixture-secret|target.example|private\?|Fixture/);
  });

  it.each([
    [{ address: "10.1.2.3", family: 4 }],
    [{ address: "93.184.216.34", family: 4 }, { address: "fd00::1", family: 6 }],
    [],
  ])("blocks unsafe DNS answers %j once and fences a leased result", async (...answers) => {
    const id = await monitor();
    const [attempt] = (await createCheckCapabilities(db).claimChecks({ max: 15 })).jobs;
    await client.query("UPDATE monitors SET status='down',failures=2,streak_started_at=now(),streak_first_error='timeout' WHERE id=$1", [id]);
    await client.query(`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause)
      VALUES ($1,$2,now()-interval '2 minutes',now(),'timeout')`, [id, owner]);
    await client.query("INSERT INTO status_pages(user_id,slug,title,is_published) VALUES ($1,'fixture-status','Fixture',true)", [owner]);
    await client.query("INSERT INTO status_page_monitors(status_page_id,user_id,monitor_id) SELECT id,user_id,$1 FROM status_pages", [id]);
    const { service, invalidateStatus } = setup(vi.fn().mockResolvedValue(answers));
    expect(await service.runMaintenance()).toMatchObject({ dnsRevalidated: 1, blocked: 1 });
    expect((await client.query("SELECT is_paused,pause_reason,config_rev,lease_id,failures,successes FROM monitors WHERE id=$1", [id])).rows)
      .toEqual([{ is_paused: true, pause_reason: "blocked_host", config_rev: 2, lease_id: null, failures: 0, successes: 0 }]);
    expect((await client.query("SELECT resolved_reason FROM incidents")).rows).toEqual([{ resolved_reason: "blocked" }]);
    expect((await client.query("SELECT state FROM check_attempts")).rows).toEqual([{ state: "dropped" }]);
    expect(invalidateStatus).toHaveBeenCalledWith(["fixture-status"]);
    const results = await createCheckCapabilities(db).ingestResults({ results: [{ ...attempt,
      startedAt: new Date(), redirectCount: 0, statusCode: 200, responseMs: 10 }] });
    expect(results[0].outcome).toBe("dropped");
    await service.runMaintenance();
    expect((await client.query("SELECT kind FROM monitor_events")).rows).toEqual([{ kind: "blocked" }]);
    expect((await client.query("SELECT id FROM alert_outbox")).rows).toEqual([]);
  });

  it("fails closed on DNS exceptions without storing the exception", async () => {
    await monitor();
    const { service, log } = setup(vi.fn().mockRejectedValue(new Error("fixture-secret-raw-error")));
    expect(await service.runMaintenance()).toMatchObject({ blocked: 1 });
    expect(JSON.stringify(log.mock.calls)).not.toContain("fixture-secret");
  });

  it("pauses a monitor when the guard's five-second DNS deadline expires", async () => {
    await monitor();
    const started = Promise.withResolvers<void>();
    const resolve = vi.fn(() => {
      started.resolve();
      return new Promise<never>(() => {});
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { service } = setup(resolve);
      const running = service.runMaintenance();
      await started.promise;
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await running).toMatchObject({ blocked: 1, dnsRevalidated: 1 });
      expect((await client.query("SELECT is_paused,pause_reason FROM monitors")).rows)
        .toEqual([{ is_paused: true, pause_reason: "blocked_host" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds DNS concurrency and leaves unfinished work due after the overall budget", async () => {
    for (let index = 0; index < 7; index++) await monitor(`target-${index}.example.invalid`);
    const sixStarted = Promise.withResolvers<void>();
    let started = 0;
    const validateMonitor = vi.fn(() => {
      if (++started === 6) sixStarted.resolve();
      return new Promise<never>(() => {});
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const service = createMaintenanceCapability(db, { validateMonitor, log: vi.fn() });
      const running = service.runMaintenance();
      await sixStarted.promise;
      await vi.advanceTimersByTimeAsync(45_001);
      expect(await running).toMatchObject({ blocked: 0, dnsRevalidated: 0 });
      expect(validateMonitor).toHaveBeenCalledTimes(6);
      expect((await client.query("SELECT id FROM monitors WHERE dns_checked_at IS NOT NULL")).rows).toEqual([]);
      expect(await setup().service.runMaintenance()).toMatchObject({ dnsRevalidated: 7, blocked: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a DNS verdict if the owner changed the configuration while it was resolving", async () => {
    const id = await monitor();
    const resolve = vi.fn(async () => {
      await client.query("UPDATE monitors SET config_rev=config_rev+1,url='https://target.example.invalid/new' WHERE id=$1", [id]);
      return [{ address: "127.0.0.1", family: 4 }];
    });
    const { service } = setup(resolve);
    expect(await service.runMaintenance()).toMatchObject({ dnsRevalidated: 0, blocked: 0 });
    expect((await client.query("SELECT is_paused,dns_checked_at FROM monitors")).rows)
      .toEqual([{ is_paused: false, dns_checked_at: null }]);
  });

  it("enforces the current blocklist even for a previously checked or owner-paused monitor", async () => {
    const id = await monitor("child.deny.example.invalid");
    await client.query("UPDATE monitors SET is_paused=true,pause_reason='user',dns_checked_at=now() WHERE id=$1", [id]);
    await client.exec("INSERT INTO blocked_hosts(host,reason) VALUES ('deny.example.invalid','fixture')");
    const { service, resolve } = setup();
    expect(await service.runMaintenance()).toMatchObject({ blocked: 1 });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps open and recently resolved incidents and the inherited pause event across yearly cleanup", async () => {
    const id = await monitor();
    const recent = randomUUID();
    await client.query(`INSERT INTO incidents(id,monitor_id,user_id,started_at,confirmed_at,resolved_at,resolved_reason,cause)
      VALUES ($1,$2,$3,now()-interval '3 years',now()-interval '3 years',now()-interval '2 years','paused','timeout'),
      ($4,$2,$3,now()-interval '3 years',now()-interval '3 years',now()-interval '1 day','paused','timeout'),
      ($5,$2,$3,now()-interval '2 years',now()-interval '2 years',null,null,'timeout')`,
      [randomUUID(), id, owner, recent, randomUUID()]);
    await client.query(`INSERT INTO monitor_events(monitor_id,kind,at) VALUES
      ($1,'paused',now()-interval '3 years'),($1,'resumed',now()-interval '2 years'),
      ($1,'paused',now()-interval '18 months'),($1,'config_changed',now()-interval '13 months'),
      ($1,'resumed',now()-interval '1 day')`, [id]);
    const { service } = setup();
    await service.runMaintenance();
    expect((await client.query("SELECT id FROM incidents")).rows).toHaveLength(2);
    expect((await client.query("SELECT id FROM incidents WHERE resolved_at IS NOT NULL")).rows).toEqual([{ id: recent }]);
    expect((await client.query("SELECT kind FROM monitor_events ORDER BY at")).rows).toEqual([{ kind: "paused" }, { kind: "resumed" }]);
  });

  it("prunes old sent alerts while preserving recent and unfinished delivery records", async () => {
    const id = await monitor();
    const channel = randomUUID();
    await client.query("INSERT INTO alert_channels(id,user_id,type,label,config_enc) VALUES ($1,$2,'webhook','Fixture','fixture')", [channel, owner]);
    for (const [status, days] of [["sent", 91], ["sent", 89], ["pending", 91], ["sending", 91], ["failed", 91]] as const) {
      const incident = randomUUID();
      await client.query(`INSERT INTO incidents(id,monitor_id,user_id,started_at,confirmed_at,resolved_at,resolved_reason,cause)
        VALUES ($1,$2,$3,now()-interval '100 days',now()-interval '100 days',now()-interval '95 days','paused','timeout')`,
        [incident, id, owner]);
      await client.query(`INSERT INTO alert_outbox(incident_id,channel_id,user_id,kind,dedupe_key,payload,status,created_at,sent_at)
        VALUES ($1,$2,$3,'down',$1::uuid::text || ':' || $2::uuid::text || ':down','{}',$4,
          now()-interval '100 days',CASE WHEN $4='sent' THEN now()-$5::int*interval '1 day' END)`,
        [incident, channel, owner, status, days]);
    }
    const { service } = setup();
    expect(await service.runMaintenance()).toMatchObject({ removed: 1 });
    expect((await client.query("SELECT status FROM alert_outbox ORDER BY status")).rows)
      .toEqual([{ status: "failed" }, { status: "pending" }, { status: "sending" }, { status: "sent" }]);
  });
});
