import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DogfoodEvidence } from "../services/dogfood-evidence.ts";
import { scoreDogfoodProof, type DogfoodProofManifest, type DogfoodIncidentReview } from "./dogfood-proof.ts";
import { parseScoreArguments, writePrivateProofReport } from "../../scripts/ops/score-dogfood.ts";

const DAY = 86_400_000;
const SLOT = 300_000;
const GRACE = 60_000;
const start = Date.parse("2026-10-01T00:00:00.000Z");
const at = (offset: number) => new Date(start + offset).toISOString();
const id = (value: number) => `10000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const ids = [id(1), id(2)];
const manifest = (): DogfoodProofManifest => ({ version: 1, startAt: at(0), monitors: ids.map(monitorId => ({ id: monitorId, configRev: 1, intervalSeconds: 300 })) });

function fixture(days = 14) {
  const end = days * DAY + GRACE + 1;
  const checks: DogfoodEvidence["checks"] = [];
  for (let target = 0; target < 2; target++) {
    for (let slot = 0; slot < days * 288; slot++) {
      checks.push({ attemptId: id(1000 + slot + target * 100_000), monitorId: ids[target], configRev: 1,
        checkedAt: at(slot * SLOT + 9000), acceptedAt: at(slot * SLOT + 10_000),
        ok: true, statusCode: 200, responseMs: 20, errorType: null, redirectCount: 0 });
    }
  }
  const anchors = ids.map((monitorId, index) => ({ id: id(100 + index), monitorId, kind: "created" as const, at: at(-DAY) }));
  const make = (from: number, to: number): DogfoodEvidence => ({ version: 1, from: at(from), to: at(to), capturedAt: at(to), missingAcceptanceEvidence: 0,
    monitors: ids.map(monitorId => ({ id: monitorId, configRev: 1, intervalSeconds: 300, isPaused: false, createdAt: at(-DAY) })),
    checks: checks.filter(check => Date.parse(check.acceptedAt ?? check.checkedAt) >= start + from && Date.parse(check.acceptedAt ?? check.checkedAt) < start + to),
    events: structuredClone(anchors), incidents: [] });
  const split = days > 7 ? 7 * DAY : end;
  return { manifest: manifest(), asOf: at(end), snapshots: split < end ? [make(0, split), make(split, end)] : [make(0, end)], reviews: [] as DogfoodIncidentReview[] };
}

describe("fixed-slot dogfood proof", () => {
  it("requires fourteen elapsed days and final grace, with both targets and all per-day checks", () => {
    const result = scoreDogfoodProof(fixture());
    expect(result.status).toBe("passed");
    expect(result.completedDays).toBe(14);
    expect(result.days).toHaveLength(14);
    expect(result.days[0]).toMatchObject({ day: 1, matured: true, status: "passed", fleet: { expected: 576, received: 576, missed: 0, excluded: 0 } });
    expect(result.days.every(day => day.monitors.every(monitor => monitor.expected === 288 && monitor.missed === 0))).toBe(true);
    const early = fixture(1);
    expect(scoreDogfoodProof(early).status).toBe("incomplete");
    expect(scoreDogfoodProof(early).completedDays).toBe(1);
  });

  it("does not mistake fourteen snapshots in one day for fourteen elapsed proof days", () => {
    const input = fixture(1);
    input.snapshots = Array.from({ length: 14 }, () => structuredClone(input.snapshots[0]));
    expect(scoreDogfoodProof(input)).toMatchObject({ status: "incomplete", completedDays: 1 });
  });

  it("counts a receipt exactly at the +60-second cutoff but not one millisecond later", () => {
    const boundary = fixture(1);
    const check = boundary.snapshots[0].checks[0];
    check.acceptedAt = at(SLOT + GRACE);
    check.checkedAt = at(SLOT + GRACE - 1000);
    boundary.snapshots[0].checks = [check];
    const result = scoreDogfoodProof(boundary).days[0].monitors[0];
    expect(result.received).toBe(1);
    check.acceptedAt = at(SLOT + GRACE + 1);
    check.checkedAt = at(SLOT + GRACE);
    // The late result can fill slot 2, but it must not fill slot 1.
    const late = scoreDogfoodProof(boundary).days[0].monitors[0];
    expect(late.received).toBe(1);
    expect(late.firstMissedSlotAt).toBe(at(0));
    expect(result.firstMissedSlotAt).toBe(at(SLOT));
  });

  it("assigns receipts to the earliest eligible unfilled slot and never reuses an overlapping result", () => {
    const input = fixture(1);
    const first = input.snapshots[0].checks[0];
    first.acceptedAt = at(SLOT + 30_000);
    first.checkedAt = at(SLOT + 29_000);
    input.snapshots[0].checks = [first, structuredClone(first)];
    input.snapshots[0].checks.push({ ...first, attemptId: id(999), acceptedAt: at(SLOT + 40_000) });
    const report = scoreDogfoodProof(input).days[0].monitors[0];
    expect(report.received).toBe(2);
    expect(report.firstMissedSlotAt).toBe(at(2 * SLOT));
  });

  it("allows two misses but fails three misses in a 288-slot day", () => {
    const input = fixture(1);
    input.snapshots[0].checks = input.snapshots[0].checks.filter(check => check.monitorId !== ids[0] || Date.parse(check.acceptedAt ?? "") >= start + 2 * SLOT);
    expect(scoreDogfoodProof(input).days[0].monitors[0]).toMatchObject({ expected: 288, missed: 2, status: "passed" });
    input.snapshots[0].checks = input.snapshots[0].checks.filter(check => check.monitorId !== ids[0] || Date.parse(check.acceptedAt ?? "") >= start + 3 * SLOT);
    expect(scoreDogfoodProof(input)).toMatchObject({ status: "failed" });
    expect(scoreDogfoodProof(input).days[0].monitors[0]).toMatchObject({ missed: 3, status: "failed" });
  });

  it("rejects exactly one percent for a monitor even when the fleet is below one percent", () => {
    const input = fixture(1);
    for (const [index, monitorId] of ids.entries()) {
      input.snapshots[0].events.push({ id: id(200 + index * 2), monitorId, kind: "paused", at: at(100 * SLOT) }, { id: id(201 + index * 2), monitorId, kind: "resumed", at: at(DAY) });
      input.snapshots[0].monitors[index].configRev = 3;
    }
    input.snapshots[0].checks = input.snapshots[0].checks.filter(check => Date.parse(check.acceptedAt ?? "") < start + 100 * SLOT && !(check.monitorId === ids[0] && check.attemptId === id(1000)));
    const result = scoreDogfoodProof(input);
    expect(result.status).toBe("failed");
    expect(result.days[0].monitors[0]).toMatchObject({ expected: 100, received: 99, missed: 1, status: "failed" });
    expect(result.days[0].fleet).toMatchObject({ expected: 200, missed: 1, status: "passed" });
  });

  it("excludes slots intersecting paused time, not an earlier slot's grace", () => {
    const input = fixture(1);
    input.snapshots[0].events.push({ id: id(250), monitorId: ids[0], kind: "paused", at: at(SLOT + 10_000) }, { id: id(251), monitorId: ids[0], kind: "resumed", at: at(SLOT + 20_000) });
    input.snapshots[0].monitors[0].configRev = 3;
    input.snapshots[0].checks = input.snapshots[0].checks.filter(check => check.monitorId !== ids[0] || check.attemptId !== id(1001));
    for (const check of input.snapshots[0].checks) if (check.monitorId === ids[0] && Date.parse(check.acceptedAt ?? "") > start + SLOT + 20_000) check.configRev = 3;
    expect(scoreDogfoodProof(input).days[0].monitors[0]).toMatchObject({ expected: 287, excluded: 1, missed: 0, status: "passed" });
  });

  it("keeps a fully paused day incomplete instead of reporting a healthy zero denominator", () => {
    const input = fixture(1);
    input.snapshots[0].events.push({ id: id(260), monitorId: ids[0], kind: "paused", at: at(1) });
    input.snapshots[0].monitors[0].configRev = 2;
    input.snapshots[0].monitors[0].isPaused = true;
    input.snapshots[0].checks = input.snapshots[0].checks.filter(check => check.monitorId !== ids[0]);
    expect(scoreDogfoodProof(input).days[0].monitors[0]).toMatchObject({ expected: 0, excluded: 288, status: "incomplete" });
  });

  it("requires an explicit active baseline anchor and consistent captured pause state", () => {
    const input = fixture();
    for (const snapshot of input.snapshots) snapshot.events = [];
    expect(scoreDogfoodProof(input)).toMatchObject({ status: "incomplete" });
    expect(scoreDogfoodProof(input).reasons).toContain("missing_pause_anchor");
    const mismatch = fixture();
    mismatch.snapshots[1].monitors[0].isPaused = true;
    expect(scoreDogfoodProof(mismatch).status).toBe("incomplete");
  });

  it("requires an unbroken evidence window for both targets, including the final inclusive cutoff", () => {
    const input = fixture();
    input.snapshots[0].to = at(7 * DAY - 1);
    input.snapshots[0].capturedAt = at(7 * DAY);
    expect(scoreDogfoodProof(input).status).toBe("incomplete");
    expect(scoreDogfoodProof(input).reasons).toContain("evidence_window_gap");
    const early = fixture();
    early.asOf = at(14 * DAY + GRACE);
    early.snapshots[1].to = early.asOf;
    early.snapshots[1].capturedAt = early.asOf;
    expect(scoreDogfoodProof(early)).toMatchObject({ status: "incomplete", completedDays: 13 });
  });

  it("prefers a previously exported receipt over a later retention-null duplicate", () => {
    const input = fixture();
    const duplicate = structuredClone(input.snapshots[0]);
    duplicate.capturedAt = input.asOf;
    duplicate.checks[0].acceptedAt = null;
    duplicate.missingAcceptanceEvidence = 1;
    input.snapshots.push(duplicate);
    expect(scoreDogfoodProof(input).status).toBe("passed");
    input.snapshots[0].checks[0].acceptedAt = null;
    input.snapshots[0].missingAcceptanceEvidence = 1;
    expect(scoreDogfoodProof(input).status).toBe("incomplete");
    expect(scoreDogfoodProof(input).reasons).toContain("missing_acceptance_evidence");
  });

  it("fails closed on conflicting known receipts and does not silently double-count snapshots", () => {
    const input = fixture();
    const duplicate = structuredClone(input.snapshots[0]);
    duplicate.checks[0].acceptedAt = at(10_001);
    input.snapshots.push(duplicate);
    expect(scoreDogfoodProof(input).status).toBe("incomplete");
    expect(scoreDogfoodProof(input).reasons).toContain("conflicting_evidence");
  });

  it("requires restart for config events, current interval changes or the operator change journal", () => {
    const changed = fixture();
    changed.snapshots[0].events.push({ id: id(300), monitorId: ids[0], kind: "config_changed", at: at(DAY) });
    expect(scoreDogfoodProof(changed).status).toBe("restart_required");
    const interval = fixture();
    interval.snapshots[1].monitors[0].intervalSeconds = 600;
    expect(scoreDogfoodProof(interval).status).toBe("restart_required");
    const journal = fixture();
    journal.manifest.configChanges = [{ id: id(301), monitorId: ids[0], at: at(DAY) }];
    expect(scoreDogfoodProof(journal).status).toBe("restart_required");
    const unexplained = fixture();
    unexplained.snapshots[1].monitors[0].configRev = 2;
    expect(scoreDogfoodProof(unexplained).status).toBe("incomplete");
    expect(scoreDogfoodProof(unexplained).reasons).toContain("unexplained_configuration_revision");
  });

  it("uses server receipt time rather than an observation's position around a revision boundary", () => {
    const input = fixture(1);
    input.snapshots[0].events.push({ id: id(400), monitorId: ids[0], kind: "paused", at: at(SLOT) }, { id: id(401), monitorId: ids[0], kind: "resumed", at: at(2 * SLOT) });
    input.snapshots[0].monitors[0].configRev = 3;
    input.snapshots[0].checks = input.snapshots[0].checks.filter(check => check.monitorId !== ids[0] || check.attemptId !== id(1001));
    for (const check of input.snapshots[0].checks) if (check.monitorId === ids[0] && Date.parse(check.acceptedAt ?? "") >= start + 2 * SLOT) check.configRev = 3;
    const skewed = input.snapshots[0].checks.find(check => check.attemptId === id(1002));
    if (!skewed) throw new Error("Missing synthetic check.");
    skewed.checkedAt = at(SLOT - 1);
    expect(scoreDogfoodProof(input).days[0].monitors[0]).toMatchObject({ excluded: 1, missed: 0, status: "passed" });
  });

  it("requires a human verdict for every overlapping incident and fails a false incident", () => {
    const input = fixture();
    const incident = { id: id(500), monitorId: ids[0], startedAt: at(-1000), confirmedAt: at(1000), resolvedAt: at(2000), resolvedConfirmedAt: at(3000), resolvedReason: "recovered" as const, cause: "timeout" as const };
    input.snapshots[0].incidents.push(incident);
    expect(scoreDogfoodProof(input).status).toBe("incomplete");
    input.reviews = [{ incidentId: incident.id, verdict: "unresolved" }];
    expect(scoreDogfoodProof(input).status).toBe("incomplete");
    input.reviews = [{ incidentId: incident.id, verdict: "false" }];
    expect(scoreDogfoodProof(input).status).toBe("failed");
    input.reviews = [{ incidentId: incident.id, verdict: "real" }];
    expect(scoreDogfoodProof(input).status).toBe("passed");
  });

  it("merges a later incident closure but refuses a later snapshot that reopens the same incident", () => {
    const input = fixture();
    const opened = { id: id(550), monitorId: ids[0], startedAt: at(DAY), confirmedAt: at(DAY + 60_000), resolvedAt: null, resolvedConfirmedAt: null, resolvedReason: null, cause: "timeout" as const };
    input.snapshots[0].incidents.push(opened);
    input.snapshots[1].incidents.push({ ...opened, resolvedAt: at(8 * DAY), resolvedConfirmedAt: at(8 * DAY + 60_000), resolvedReason: "recovered" });
    input.reviews = [{ incidentId: opened.id, verdict: "real" }];
    expect(scoreDogfoodProof(input).status).toBe("passed");
    input.snapshots[0].incidents[0] = { ...opened, resolvedAt: at(2 * DAY), resolvedConfirmedAt: at(2 * DAY + 60_000), resolvedReason: "recovered" };
    input.snapshots[1].incidents[0] = opened;
    expect(scoreDogfoodProof(input).status).toBe("incomplete");
    expect(scoreDogfoodProof(input).reasons).toContain("conflicting_evidence");
  });

  it("rejects malformed, future-dated and private-field-bearing evidence instead of copying it to reports", () => {
    const input = fixture();
    expect(() => scoreDogfoodProof({ ...input, manifest: { ...input.manifest, url: "https://private.example/?secret=value" } })).toThrow("Dogfood proof inputs are invalid.");
    expect(() => scoreDogfoodProof({ ...input, reviews: [{ incidentId: id(1), verdict: "real", notes: "private" }] })).toThrow();
    const future = fixture();
    future.snapshots[0].capturedAt = at(15 * DAY);
    expect(() => scoreDogfoodProof(future)).toThrow();
    expect(JSON.stringify(scoreDogfoodProof(input))).not.toMatch(/url|name|email|host|notes|statusCode|responseMs|errorType/);
  });
});

describe("offline proof command", () => {
  const args = ["--manifest", "/tmp/manifest.json", "--evidence", "/tmp/first.json,/tmp/second.json", "--reviews", "/tmp/reviews.json", "--as-of", at(14 * DAY + GRACE + 1), "--output", "/tmp/report.json"];
  it("requires exact options, bounded JSON paths and rejects duplicate or unknown options", () => {
    expect(parseScoreArguments(args)).toEqual({ manifest: "/tmp/manifest.json", evidence: ["/tmp/first.json", "/tmp/second.json"], reviews: "/tmp/reviews.json", asOf: at(14 * DAY + GRACE + 1), output: "/tmp/report.json" });
    for (const invalid of [args.slice(2), [...args, "--extra", "value"], [...args, "--manifest", "/tmp/other.json"], args.slice(0, -1), args.map(arg => arg === "/tmp/first.json,/tmp/second.json" ? "/tmp/first.json,/tmp/first.json" : arg)]) {
      expect(() => parseScoreArguments(invalid)).toThrow();
    }
  });

  it("writes a new 0600 report outside source and refuses overwrite or symlink output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-proof-test-"));
    try {
      const output = join(directory, "report.json");
      const report = scoreDogfoodProof(fixture(1));
      await writePrivateProofReport(output, report);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual(report);
      await expect(writePrivateProofReport(output, report)).rejects.toThrow();
      const link = join(directory, "link.json");
      await symlink(output, link);
      await expect(writePrivateProofReport(link, report)).rejects.toThrow();
      await expect(writePrivateProofReport(fileURLToPath(new URL("../proof-report.json", import.meta.url)), report)).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("runs entirely offline, writes incomplete progress and refuses future-clock or private-field inputs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-proof-cli-"));
    try {
      const input = fixture(1);
      const manifest = join(directory, "manifest.json"), evidence = join(directory, "evidence.json"), reviews = join(directory, "reviews.json"), output = join(directory, "report.json");
      await writeFile(manifest, JSON.stringify(input.manifest));
      await writeFile(evidence, JSON.stringify(input.snapshots[0]));
      await writeFile(reviews, JSON.stringify({ version: 1, reviews: [] }));
      const command = (asOf = input.asOf, report = output) => spawnSync(process.execPath, [
        fileURLToPath(new URL("../../scripts/ops/score-dogfood.ts", import.meta.url)),
        "--manifest", manifest, "--evidence", evidence, "--reviews", reviews, "--as-of", asOf, "--output", report,
      ], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: "test", MIGRATION_DATABASE_URL: "private-credential-must-not-be-used" } });
      const progress = command();
      expect(progress.error).toBeUndefined();
      expect(progress.status).toBe(2);
      expect(progress.stdout).toContain("Status: incomplete");
      expect(progress.stderr).not.toContain("private-credential");
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ status: "incomplete", completedDays: 1 });
      const future = command("2099-01-01T00:00:00.000Z", join(directory, "future.json"));
      expect(future.status).toBe(1);
      await expect(stat(join(directory, "future.json"))).rejects.toThrow();
      await writeFile(manifest, JSON.stringify({ ...input.manifest, notes: "private-secret-notes" }));
      const refused = command(input.asOf, join(directory, "invalid.json"));
      expect(refused.status).toBe(1);
      expect(refused.stdout + refused.stderr).not.toContain("private-secret-notes");
      await expect(stat(join(directory, "invalid.json"))).rejects.toThrow();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
