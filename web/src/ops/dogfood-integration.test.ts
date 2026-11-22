import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDogfoodEvidenceCapability } from "../services/dogfood-evidence.ts";
import { scoreDogfoodProof, type DogfoodProofManifest } from "./dogfood-proof.ts";

const DAY = 86_400_000;
const GRACE = 60_000;
const start = Date.parse("2026-10-01T00:00:00.000Z");
const at = (offset: number) => new Date(start + offset).toISOString();
const owner = "a1000000-0000-4000-8000-000000000001";
const monitorIds = ["a2000000-0000-4000-8000-000000000001", "a2000000-0000-4000-8000-000000000002"];
const manifest: DogfoodProofManifest = {
  version: 1,
  startAt: at(0),
  monitors: monitorIds.map(id => ({ id, configRev: 1, intervalSeconds: 300 })),
};
let client: PGlite;
let exporter: ReturnType<typeof createDogfoodEvidenceCapability>;

beforeAll(async () => {
  client = new PGlite();
  const db = drizzle(client);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
  exporter = createDogfoodEvidenceCapability(db);
}, 30_000);
beforeEach(async () => {
  await client.exec("TRUNCATE users CASCADE");
  await client.query("INSERT INTO users(id,name) VALUES ($1,'Synthetic proof owner')", [owner]);
  for (const id of monitorIds) {
    await client.query(`INSERT INTO monitors(id,user_id,name,url,host,created_at)
      VALUES ($1,$2,'Private fixture target','https://private.example.invalid/?token=synthetic','private.example.invalid',$3)`,
    [id, owner, at(-DAY)]);
    await client.query("INSERT INTO monitor_events(id,monitor_id,kind,at) VALUES ($1,$2,'created',$3)", [randomUUID(), id, at(-DAY)]);
  }
});
afterAll(async () => { await client?.close(); });

async function seedAcceptedChecks(slots: number, boundaryReceipt: string) {
  for (const id of monitorIds) {
    await client.query(`INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms)
      SELECT gen_random_uuid(),$1::uuid,1,$2::timestamptz+slot*interval '5 minutes'+interval '9 seconds',true,200,20
      FROM generate_series(0,$3::int-1) AS slot`, [id, at(0), slots]);
  }
  // Deliberately place one real receipt at the inclusive grace boundary.
  // It remains eligible for the prior slot even though its observation is after midnight.
  await client.query(`UPDATE checks SET checked_at=$1::timestamptz-interval '1 second'
    WHERE id=(SELECT id FROM checks WHERE monitor_id=$2 ORDER BY checked_at DESC LIMIT 1)`, [boundaryReceipt, monitorIds[0]]);
  await client.exec(`INSERT INTO check_attempts(attempt_id,monitor_id,config_rev,expected_status,state,claimed_at,expires_at,terminal_at)
    SELECT attempt_id,monitor_id,config_rev,'2xx','done',checked_at-interval '1 second',
      checked_at+interval '119 seconds',checked_at+interval '1 second' FROM checks`);
}

async function snapshot(from: number, to: number) {
  return exporter.exportDogfoodEvidence({ monitorIds, from: at(from), to: at(to) });
}

describe("database evidence and offline proof integration", () => {
  it("requires evidence through the daily grace boundary and never reuses its receipt in the next day", async () => {
    await seedAcceptedChecks(288, at(DAY + GRACE));
    const cutoffWindow = await snapshot(0, DAY + GRACE);
    const boundaryCheck = cutoffWindow.checks.find(check => check.monitorId === monitorIds[0] && check.acceptedAt === at(DAY + GRACE));
    expect(boundaryCheck).toMatchObject({ checkedAt: at(DAY + GRACE - 1000), acceptedAt: at(DAY + GRACE) });
    const beforeCoverage = scoreDogfoodProof({ manifest, asOf: cutoffWindow.capturedAt, snapshots: [cutoffWindow], reviews: [] });
    expect(beforeCoverage.days[0]).toMatchObject({ status: "incomplete", fleet: { expected: 576, received: 576, missed: 0 } });
    expect(beforeCoverage.reasons).toContain("evidence_window_gap");

    const firstWindow = await snapshot(0, DAY + GRACE + 1);
    const nextWindow = await snapshot(DAY, 2 * DAY + GRACE + 1);
    const boundaryCopies = [...firstWindow.checks, ...nextWindow.checks].filter(check => check.attemptId === boundaryCheck?.attemptId);
    expect(boundaryCopies).toHaveLength(2);
    const report = scoreDogfoodProof({ manifest, asOf: nextWindow.capturedAt, snapshots: [firstWindow, nextWindow], reviews: [] });
    expect(report.days[0]).toMatchObject({ status: "passed", fleet: { expected: 576, received: 576, missed: 0 } });
    expect(report.days[1].monitors[0]).toMatchObject({ expected: 288, received: 0, missed: 288, firstMissedSlotAt: at(DAY) });
    expect(report.days[1].fleet).toMatchObject({ expected: 576, received: 0, missed: 576 });
  });

  it("passes fourteen days only after exporting past the inclusive final grace cutoff", async () => {
    const finalCutoff = 14 * DAY + GRACE;
    await seedAcceptedChecks(14 * 288, at(finalCutoff));
    const first = await snapshot(0, 7 * DAY);
    const finalExclusive = await snapshot(7 * DAY, finalCutoff);
    expect(first.checks.length + finalExclusive.checks.length).toBe(8064);
    expect(finalExclusive.missingAcceptanceEvidence).toBe(0);
    expect(finalExclusive.checks.some(check => check.monitorId === monitorIds[0] && check.acceptedAt === at(finalCutoff))).toBe(true);
    const incomplete = scoreDogfoodProof({ manifest, asOf: finalExclusive.capturedAt, snapshots: [first, finalExclusive], reviews: [] });
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.days[13]).toMatchObject({ status: "incomplete", fleet: { expected: 576, received: 576, missed: 0 } });
    expect(incomplete.reasons).toContain("evidence_window_gap");

    const finalInclusive = await snapshot(7 * DAY, finalCutoff + 1);
    const complete = scoreDogfoodProof({ manifest, asOf: finalInclusive.capturedAt, snapshots: [first, finalInclusive], reviews: [] });
    expect(complete).toMatchObject({ status: "passed", completedDays: 14, requiredThrough: at(finalCutoff), reasons: [] });
    expect(complete.days).toHaveLength(14);
    expect(complete.days.every(day => day.status === "passed" && day.fleet.expected === 576 && day.fleet.received === 576 && day.fleet.missed === 0)).toBe(true);
    expect(JSON.stringify(complete)).not.toMatch(/private\.example|token=synthetic|Private fixture target|userId|user_id/);
  }, 15_000);
});
