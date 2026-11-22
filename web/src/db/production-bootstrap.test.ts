import { describe, expect, it } from "vitest";
import {
  assertEmptyProductionSnapshot,
  readProductionSetup,
} from "../../scripts/db/production.ts";

const runtime = "postgresql://postgres.fixture:synthetic-admin-password@aws-0-test.pooler.supabase.com:6543/postgres";
const admin = "postgresql://postgres.fixture:synthetic-admin-password@aws-0-test.pooler.supabase.com:5432/postgres";
const environment = { DATABASE_URL: runtime, MIGRATION_DATABASE_URL: admin };
const confirmation = ["--confirm-fresh-production-project"];
const expected = [{ hash: "fixture-hash", folderMillis: 1 }];

describe("fresh production database bootstrap", () => {
  it("requires an exact confirmation and rejects unknown, duplicate and ambiguous arguments", () => {
    for (const args of [[], ["--resume-after-migration"], [...confirmation, "--other"], [...confirmation, ...confirmation]]) {
      expect(() => readProductionSetup(environment, args)).toThrow("Production database configuration is invalid.");
    }
    expect(readProductionSetup(environment, confirmation)).toMatchObject({ runtimeUrl: runtime, adminUrl: admin, resume: false });
    expect(readProductionSetup(environment, [...confirmation, "--resume-after-migration"]).resume).toBe(true);
  });

  it("requires the same project and database with transaction and migration connection modes", () => {
    for (const env of [
      { ...environment, DATABASE_URL: runtime.replace(":6543", ":5432") },
      { ...environment, MIGRATION_DATABASE_URL: admin.replace(":5432", ":6543") },
      { ...environment, MIGRATION_DATABASE_URL: admin.replace("postgres.fixture:", "postgres.other:") },
      { ...environment, MIGRATION_DATABASE_URL: admin.replace("/postgres", "/another") },
      { ...environment, DATABASE_URL: runtime.replace("postgres.fixture:", "unknown.fixture:") },
      { ...environment, MIGRATION_DATABASE_URL: admin.replace("postgres.fixture:", "monitrail_app.fixture:") },
      { ...environment, MIGRATION_DATABASE_URL: "postgresql://postgres:synthetic@db.other.supabase.co/postgres" },
    ]) expect(() => readProductionSetup(env, confirmation)).toThrow("Production database configuration is invalid.");
    expect(readProductionSetup({ ...environment, MIGRATION_DATABASE_URL: "postgresql://postgres:synthetic@db.fixture.supabase.co/postgres" }, confirmation)).toMatchObject({ resume: false });
  });

  it("accepts the saved restricted runtime credential only for an explicit resume", () => {
    const restricted = { ...environment, DATABASE_URL: runtime.replace("postgres.fixture:", "monitrail_app.fixture:") };
    expect(() => readProductionSetup(restricted, confirmation)).toThrow("Production database configuration is invalid.");
    expect(readProductionSetup(restricted, [...confirmation, "--resume-after-migration"]).runtimeUrl).toContain("monitrail_app.fixture:");
  });

  it("does not expose credentials in rejected input errors", () => {
    try { readProductionSetup({ ...environment, DATABASE_URL: "secret-fixture" }, confirmation); }
    catch (error) { expect(String(error)).not.toContain("secret-fixture"); }
  });

  it("requires an entirely empty public schema for a first run", () => {
    expect(() => assertEmptyProductionSnapshot({ tables: [], applied: [], counts: [] }, false, expected, ["users"])).not.toThrow();
    for (const snapshot of [
      { tables: ["users"], applied: [], counts: [{ table: "users", count: 0 }] },
      { tables: ["unrelated_application"], applied: [], counts: [] },
      { tables: [], applied: [{ hash: "fixture-hash", createdAt: 1 }], counts: [] },
    ]) expect(() => assertEmptyProductionSnapshot(snapshot, false, expected, ["users"])).toThrow("Production target verification failed.");
  });

  it("resumes only an exact committed schema and migration history with no data", () => {
    const snapshot = { tables: ["users"], applied: [{ hash: "fixture-hash", createdAt: 1 }], counts: [{ table: "users", count: 0 }] };
    expect(() => assertEmptyProductionSnapshot(snapshot, true, expected, ["users"])).not.toThrow();
    for (const candidate of [
      { ...snapshot, tables: [] },
      { ...snapshot, tables: ["users", "foreign_table"] },
      { ...snapshot, applied: [{ hash: "tampered", createdAt: 1 }] },
      { ...snapshot, applied: [{ hash: "fixture-hash", createdAt: 2 }] },
      { ...snapshot, applied: [] },
      { ...snapshot, counts: [{ table: "users", count: 1 }] },
      { ...snapshot, counts: [] },
      { ...snapshot, counts: [{ table: "users", count: -1 }] },
    ]) expect(() => assertEmptyProductionSnapshot(candidate, true, expected, ["users"])).toThrow("Production target verification failed.");
  });
});
