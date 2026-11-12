import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertSender } from "../alerts/contracts.ts";
import type { DataExecutor } from "../data/access.ts";
import { createOutboxCapability } from "./alert-outbox.ts";
import type { AttemptResult } from "./capabilities.ts";
import { createCheckCapabilities } from "./checks.ts";

const owner = "b1000000-0000-4000-8000-000000000001";
const max = 15 as const;
const healthy = { statusCode: 204, responseMs: 25 };
const outage = { errorType: "timeout" } as const;
const accepted = { ok: true } as const;
const timedOut = { ok: false, category: "timeout" } as const;
const config = "fixture-encrypted-destination";

type OutboxRow = {
  id: string;
  kind: "down" | "up";
  status: string;
  attempts: number;
  claimed_until: Date | null;
  last_error_category: string | null;
};

describe("alert delivery outbox", () => {
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
    await client.exec("TRUNCATE users,system_heartbeat CASCADE");
    await client.query("INSERT INTO users(id,name) VALUES($1,'Fixture')", [owner]);
  });

  afterAll(async () => {
    await client?.close();
  });

  async function seed(channelVerification = [true]) {
    const { rows: [monitor] } = await client.query<{ id: string }>(
      `INSERT INTO monitors(user_id,name,url,host)
        VALUES($1,'Fixture monitor','https://fixture.example.invalid/?private=value','fixture.example.invalid')
        RETURNING id`,
      [owner],
    );
    const channels = [];
    for (const verified of channelVerification) {
      const { rows: [channel] } = await client.query<{ id: string }>(
        `INSERT INTO alert_channels(user_id,type,label,config_enc,is_verified)
          VALUES($1,'webhook','Fixture',$2,$3) RETURNING id`,
        [owner, config, verified],
      );
      channels.push(channel.id);
      await client.query(
        "INSERT INTO monitor_alert_channels(monitor_id,channel_id,user_id) VALUES($1,$2,$3)",
        [monitor.id, channel.id, owner],
      );
    }
    return { monitor: monitor.id, channels };
  }

  async function observe(monitorId: string, measurement: typeof healthy | typeof outage) {
    await client.query(
      "UPDATE monitors SET next_check_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [monitorId],
    );
    const checks = createCheckCapabilities(db);
    const { jobs: [job] } = await checks.claimChecks({ max });
    expect(job.monitorId).toBe(monitorId);
    const result: AttemptResult = {
      attemptId: job.attemptId,
      monitorId,
      configRev: job.configRev,
      startedAt: new Date(),
      redirectCount: 0,
      ...measurement,
    };
    expect(await checks.ingestResults({ results: [result] })).toEqual([
      { attemptId: job.attemptId, outcome: "accepted" },
    ]);
    return result;
  }

  async function incident(monitorId: string, recover = false) {
    await observe(monitorId, outage);
    const down = await observe(monitorId, outage);
    if (!recover) return down;
    await observe(monitorId, healthy);
    return observe(monitorId, healthy);
  }

  async function outbox() {
    return (await client.query<OutboxRow>(
      "SELECT id,kind,status,attempts,claimed_until,last_error_category FROM alert_outbox ORDER BY kind,id",
    )).rows;
  }

  async function makeLeaseRetryable() {
    await client.exec(`UPDATE alert_outbox
      SET claimed_until=clock_timestamp()-interval '1 second',
        next_attempt_at=clock_timestamp()-interval '1 second'
      WHERE status='sending'`);
  }

  it("delivers one down and one up per verified subscription after ingest and ignores a replay", async () => {
    const { monitor, channels } = await seed([true, true, false]);
    const result = await incident(monitor, true);
    expect(await createCheckCapabilities(db).ingestResults({ results: [result] })).toEqual([
      { attemptId: result.attemptId, outcome: "dropped" },
    ]);
    const send = vi.fn<AlertSender>().mockResolvedValue(accepted);
    const service = createOutboxCapability(db, send);

    expect(await outbox()).toHaveLength(4);
    expect(await service.deliverOutbox()).toEqual({ sent: 2, retrying: 0, failed: 0 });
    expect(send.mock.calls.map(([delivery]) => delivery.id).sort()).toEqual(channels.slice(0, 2).sort());
    expect(send.mock.calls.every(([delivery]) =>
      (delivery.payload as { event: string }).event === "incident.opened")).toBe(true);
    expect(await service.deliverOutbox()).toEqual({ sent: 2, retrying: 0, failed: 0 });
    expect(await service.deliverOutbox()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    const stored = await outbox();
    expect(stored.every(row => row.status === "sent" && row.attempts === 1)).toBe(true);
    const payloads = send.mock.calls.map(([delivery]) => delivery.payload);
    expect(payloads.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "incident.resolved", sent_at: expect.any(String) }),
    ]));
    expect(payloads.map(payload => (payload as { event_id: string }).event_id).sort())
      .toEqual(stored.map(row => row.id).sort());
    expect(JSON.stringify(payloads)).not.toMatch(/private=value|fixture-encrypted-destination/);
  });

  it("retries an ambiguous send on the approved schedule and stops after six attempts", async () => {
    const { monitor } = await seed();
    await incident(monitor);
    const send = vi.fn<AlertSender>().mockResolvedValue(timedOut);
    const service = createOutboxCapability(db, send);
    for (const [index, minutes] of [11, 22, 44, 88, 176].entries()) {
      expect(await service.deliverOutbox()).toEqual({ sent: 0, retrying: 1, failed: 0 });
      expect((await outbox())[0]).toMatchObject({
        attempts: index + 1, status: "pending", last_error_category: "timeout", claimed_until: null,
      });
      const { rows: [{ seconds }] } = await client.query<{ seconds: number }>(
        "SELECT ceil(extract(epoch FROM next_attempt_at-clock_timestamp()))::int AS seconds FROM alert_outbox",
      );
      expect(seconds).toBeGreaterThan(minutes * 60 - 3);
      expect(seconds).toBeLessThanOrEqual(minutes * 60);
      expect(await service.deliverOutbox()).toEqual({ sent: 0, retrying: 0, failed: 0 });
      await client.exec("UPDATE alert_outbox SET next_attempt_at=clock_timestamp()-interval '1 second'");
    }
    expect(await service.deliverOutbox()).toEqual({ sent: 0, retrying: 0, failed: 1 });
    expect((await outbox())[0]).toMatchObject({ attempts: 6, status: "failed" });
    expect(send).toHaveBeenCalledTimes(6);
    expect(new Set(send.mock.calls.map(([delivery]) => (delivery.payload as { event_id: string }).event_id)).size).toBe(1);
  });

  it("recovers a lost settlement after a provider accepted the send with the same event ID", async () => {
    const { monitor } = await seed();
    await incident(monitor);
    let executions = 0;
    const crash: DataExecutor = {
      execute(statement) {
        if (++executions === 3) throw new Error("synthetic lost settlement");
        return db.execute(statement);
      },
    };
    const send = vi.fn<AlertSender>().mockResolvedValue(accepted);
    await createOutboxCapability(crash, send).deliverOutbox();
    expect(send).toHaveBeenCalledTimes(1);
    expect((await outbox())[0]).toMatchObject({ attempts: 1, status: "sending" });
    await makeLeaseRetryable();
    expect(await createOutboxCapability(db, send).deliverOutbox()).toEqual({
      sent: 1, retrying: 0, failed: 0,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1][0].payload as { event_id: string }).event_id)
      .toBe((send.mock.calls[0][0].payload as { event_id: string }).event_id);
  });

  it("keeps a live claim exclusive and fences a late first attempt after reclaim", async () => {
    const { monitor } = await seed();
    await incident(monitor);
    const started = Promise.withResolvers<void>();
    const late = Promise.withResolvers<typeof timedOut>();
    const slow = vi.fn<AlertSender>().mockImplementation(() => {
      started.resolve();
      return late.promise;
    });
    const first = createOutboxCapability(db, slow).deliverOutbox();
    await started.promise;
    try {
      const send = vi.fn<AlertSender>().mockResolvedValue(accepted);
      const replacement = createOutboxCapability(db, send);
      expect(await replacement.deliverOutbox()).toEqual({ sent: 0, retrying: 0, failed: 0 });
      await makeLeaseRetryable();
      expect(await replacement.deliverOutbox()).toEqual({ sent: 1, retrying: 0, failed: 0 });
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      late.resolve(timedOut);
      await first;
    }
    expect((await outbox())[0]).toMatchObject({
      attempts: 2, status: "sent", claimed_until: null, last_error_category: null,
    });
  });

  it("expires down after six hours but starts recovery's window after its down is sent", async () => {
    const { monitor } = await seed([true, true]);
    await incident(monitor, true);
    const send = vi.fn<AlertSender>().mockResolvedValue(accepted);
    const service = createOutboxCapability(db, send);
    const { rows: [channel] } = await client.query<{ id: string }>(
      "SELECT id FROM alert_channels ORDER BY id LIMIT 1",
    );
    await client.exec("UPDATE alert_outbox SET created_at=clock_timestamp()-interval '7 hours'");
    await client.query(
      "UPDATE alert_outbox SET status='sent',sent_at=clock_timestamp()-interval '1 minute' WHERE kind='down' AND channel_id=$1",
      [channel.id],
    );
    await service.deliverOutbox();
    await service.deliverOutbox();
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id: channel.id, payload: expect.objectContaining({ event: "incident.resolved" }),
    }));
    expect((await outbox()).map(row => row.status).sort())
      .toEqual(["failed", "failed", "sent", "sent"]);
  });

  it("never delivers a recovery with a missing down or an unverified destination", async () => {
    const { monitor, channels: [missing, unverified] } = await seed([true, true]);
    await incident(monitor, true);
    await client.query("DELETE FROM alert_outbox WHERE kind='down' AND channel_id=$1", [missing]);
    await client.query("UPDATE alert_channels SET is_verified=false WHERE id=$1", [unverified]);
    const send = vi.fn<AlertSender>().mockResolvedValue(accepted);
    expect(await createOutboxCapability(db, send).deliverOutbox()).toEqual({
      sent: 0, retrying: 0, failed: 3,
    });
    expect(send).not.toHaveBeenCalled();
    expect((await outbox()).every(row => row.status === "failed" && row.attempts === 0)).toBe(true);
  });

  it("discards extra payload fields and keeps unexpected provider diagnostics private", async () => {
    const { monitor } = await seed();
    await incident(monitor);
    await client.exec(`UPDATE alert_outbox SET payload=payload || '{"extra":"fixture-extra-field"}'`);
    const send = vi.fn<AlertSender>().mockRejectedValue(new Error("fixture-private-provider-diagnostic"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await createOutboxCapability(db, send).deliverOutbox()).toEqual({
        sent: 0, retrying: 1, failed: 0,
      });
      expect(JSON.stringify(send.mock.calls[0][0].payload)).not.toContain("fixture-extra-field");
      expect((await outbox())[0]).toMatchObject({ status: "pending", last_error_category: "other" });
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
