import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseExportArguments, writePrivateEvidence } from "../../scripts/ops/export-dogfood.ts";
import { createDogfoodEvidenceCapability } from "./dogfood-evidence.ts";
import type { DataExecutor } from "../data/access.ts";

const owner = "a1000000-0000-4000-8000-000000000001";
const other = "a1000000-0000-4000-8000-000000000002";
const from = "2026-11-01T00:00:00.000Z";
const to = "2026-11-02T00:00:00.000Z";
let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
}, 30_000);
beforeEach(async () => {
  await client.exec("TRUNCATE users CASCADE");
  await client.query("INSERT INTO users(id,name,email) VALUES ($1,'Private owner','private@example.invalid'),($2,'Other owner',null)", [owner, other]);
});
afterAll(async () => { await client?.close(); });

async function monitor(userId = owner) {
  const id = randomUUID();
  await client.query(`INSERT INTO monitors(id,user_id,name,url,host,created_at)
    VALUES ($1,$2,'private-monitor-name','https://private.example.invalid/target?token=private-query','private.example.invalid',$3)`,
  [id, userId, from]);
  return id;
}

async function observation(id: string, checkedAt: string, acceptedAt: string | null, revision = 1) {
  const attempt = randomUUID();
  if (acceptedAt) await client.query(`INSERT INTO check_attempts(attempt_id,monitor_id,config_rev,expected_status,state,claimed_at,expires_at,terminal_at)
    VALUES ($1,$2,$3,'2xx','done',$4::timestamptz-interval '10 seconds',$4::timestamptz+interval '110 seconds',$5)`,
  [attempt, id, revision, checkedAt, acceptedAt]);
  await client.query(`INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms)
    VALUES ($1,$2,$3,$4,true,200,20)`, [attempt, id, revision, checkedAt]);
  return attempt;
}

describe("operator dogfood evidence", () => {
  it("exports only selected monitors, allowlisted observations and successful server receipt timestamps", async () => {
    const selected = await monitor();
    const excluded = await monitor(other);
    const attempt = await observation(selected, "2026-11-01T01:00:00.000Z", "2026-11-01T01:00:10.000Z");
    await observation(excluded, "2026-11-01T02:00:00.000Z", "2026-11-01T02:00:05.000Z");
    await observation(selected, to, "2026-11-02T00:00:05.000Z");
    const result = await createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: [selected], from, to });
    expect(result).toMatchObject({ version: 1, from, to, missingAcceptanceEvidence: 0 });
    expect(result.monitors).toEqual([{ id: selected, configRev: 1, intervalSeconds: 300, isPaused: false, createdAt: from }]);
    expect(result.checks).toEqual([{
      attemptId: attempt, monitorId: selected, configRev: 1, checkedAt: "2026-11-01T01:00:00.000Z",
      acceptedAt: "2026-11-01T01:00:10.000Z", ok: true, statusCode: 200, responseMs: 20, errorType: null, redirectCount: 0,
    }]);
    expect(Date.parse(result.capturedAt)).toBeGreaterThanOrEqual(Date.parse(to));
    expect(JSON.stringify(result)).not.toMatch(/private-monitor|private-query|private\.example|private@example|userId|user_id|url|host|name|email/i);
  });

  it("flags pruned or mismatched receipt evidence instead of treating observation time as receipt time", async () => {
    const selected = await monitor();
    const pruned = await observation(selected, "2026-11-01T01:00:00.000Z", null);
    const mismatch = await observation(selected, "2026-11-01T02:00:00.000Z", "2026-11-01T02:00:10.000Z");
    await client.query("UPDATE check_attempts SET config_rev=2 WHERE attempt_id=$1", [mismatch]);
    const result = await createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: [selected], from, to });
    expect(result.missingAcceptanceEvidence).toBe(2);
    expect(result.checks.map(({ attemptId, acceptedAt }) => ({ attemptId, acceptedAt })))
      .toEqual([{ attemptId: pruned, acceptedAt: null }, { attemptId: mismatch, acceptedAt: null }]);
  });

  it("captures a server acceptance inside the window when its observation preceded the boundary", async () => {
    const selected = await monitor();
    const attempt = await observation(selected, "2026-10-31T23:59:50.000Z", "2026-11-01T00:00:01.000Z");
    const result = await createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: [selected], from, to });
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ attemptId: attempt, checkedAt: "2026-10-31T23:59:50.000Z", acceptedAt: "2026-11-01T00:00:01.000Z" });
  });

  it("keeps the pause-state boundary event and overlapping incidents without leaking private fields", async () => {
    const selected = await monitor();
    await client.query(`INSERT INTO monitor_events(monitor_id,kind,at) VALUES
      ($1,'created','2026-10-01'),($1,'paused','2026-10-30'),($1,'config_changed','2026-10-31'),
      ($1,'resumed','2026-11-01T01:00:00Z'),($1,'paused','2026-11-02T00:00:00Z')`, [selected]);
    await client.query(`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,resolved_at,resolved_reason,cause)
      VALUES ($1,$2,'2026-10-31T23:00Z','2026-10-31T23:01Z','2026-11-01T00:10Z','paused','timeout'),
      ($1,$2,'2026-10-30T23:00Z','2026-10-30T23:01Z','2026-10-31T00:10Z','paused','dns')`, [selected, owner]);
    const result = await createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: [selected], from, to });
    expect(result.events.map(({ kind }) => kind)).toEqual(["paused", "resumed"]);
    expect(result.incidents).toHaveLength(1);
    expect(result.incidents[0]).toMatchObject({ monitorId: selected, cause: "timeout", resolvedReason: "paused" });
    expect(JSON.stringify(result.incidents)).not.toMatch(/userId|user_id|url|name|host|email/i);
  });

  it.each([
    { monitorIds: [], from, to },
    { monitorIds: [owner, owner], from, to },
    { monitorIds: [owner, other, randomUUID(), randomUUID()], from, to },
    { monitorIds: ["owner'; DROP TABLE users"], from, to },
    { monitorIds: [owner], from: "2026-02-30T00:00:00.000Z", to },
    { monitorIds: [owner], from: "2026-11-01T00:00:00+00:00", to },
    { monitorIds: [owner], from, to: from },
    { monitorIds: [owner], from, to: "2026-11-16T00:00:00.000Z" },
    { monitorIds: [owner], from, to, userId: owner },
  ])("rejects unbounded or ambiguous input before accessing storage", async (input) => {
    const execute = vi.fn();
    const transaction = vi.fn();
    await expect(createDogfoodEvidenceCapability({ execute, transaction }).exportDogfoodEvidence(input)).rejects.toThrow("Dogfood evidence could not be exported.");
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("requires every explicitly selected monitor and refuses future evidence windows", async () => {
    const selected = await monitor();
    await expect(createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: [selected, randomUUID()], from, to })).rejects.toThrow("Dogfood evidence could not be exported.");
    await expect(createDogfoodEvidenceCapability(db).exportDogfoodEvidence({ monitorIds: [selected], from: "2099-01-01T00:00:00.000Z", to: "2099-01-02T00:00:00.000Z" })).rejects.toThrow("Dogfood evidence could not be exported.");
  });

  it("requires a transaction and suppresses raw database failures", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("postgres://private-credential"));
    await expect(createDogfoodEvidenceCapability({ execute }).exportDogfoodEvidence({ monitorIds: [owner], from, to })).rejects.toThrow("Dogfood evidence could not be exported.");
    expect(execute).not.toHaveBeenCalled();
    await expect(createDogfoodEvidenceCapability({ execute, transaction: vi.fn().mockRejectedValue(new Error("private-credential")) }).exportDogfoodEvidence({ monitorIds: [owner], from, to })).rejects.toThrow("Dogfood evidence could not be exported.");
  });

  it("puts the database transaction in read-only mode before reading evidence", async () => {
    const selected = await monitor();
    let readonly: unknown;
    let isolated: unknown;
    const guarded: DataExecutor = {
      execute: db.execute.bind(db),
      transaction: action => db.transaction(async tx => {
        const result = await action(tx);
        readonly = (await tx.execute(sql`SHOW transaction_read_only`)).rows[0];
        isolated = (await tx.execute(sql`SHOW transaction_isolation`)).rows[0];
        return result;
      }),
    };
    await createDogfoodEvidenceCapability(guarded).exportDogfoodEvidence({ monitorIds: [selected], from, to });
    expect(readonly).toEqual({ transaction_read_only: "on" });
    expect(isolated).toEqual({ transaction_isolation: "repeatable read" });
  });
});

describe("private evidence command", () => {
  const args = ["--confirm-export-private-evidence", "--monitors", owner, "--from", from, "--to", to, "--output", "/tmp/private-evidence.json"];
  it("parses one explicit bounded export and rejects unknown, duplicate and missing options", () => {
    expect(parseExportArguments(args)).toEqual({ monitorIds: [owner], from, to, output: "/tmp/private-evidence.json" });
    for (const invalid of [args.slice(1), [...args, "--extra"], [...args, "--from", from], args.slice(0, -1), args.map(arg => arg === owner ? `${owner},` : arg)]) {
      expect(() => parseExportArguments(invalid)).toThrow();
    }
  });

  it("writes a new private file and refuses to overwrite, follow a symlink or write inside the checkout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-evidence-test-"));
    try {
      const path = join(directory, "evidence.json");
      await writePrivateEvidence(path, { version: 1 });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1 });
      await expect(writePrivateEvidence(path, { version: 2 })).rejects.toThrow();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1 });
      const sourcePath = fileURLToPath(new URL("../../private-evidence-test.json", import.meta.url));
      await expect(writePrivateEvidence(sourcePath, { version: 1 })).rejects.toThrow();
      const link = join(directory, "linked.json");
      await symlink(path, link);
      await expect(writePrivateEvidence(link, { version: 2 })).rejects.toThrow();
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
