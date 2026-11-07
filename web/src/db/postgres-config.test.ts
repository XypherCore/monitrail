import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  postgresOptions,
  postgresProject,
  readPostgresUrl,
  readRuntimePostgresUrl,
} from "./postgres-config.ts";

describe("Supabase PostgreSQL configuration", () => {
  it("recognizes the same project across direct and both pooled usernames", () => {
    for (const value of [
      "postgresql://synthetic:fixture@db.project-fixture.supabase.co/postgres",
      "postgresql://postgres.project-fixture:fixture@aws-0-fixture.pooler.supabase.com/postgres",
      "postgresql://monitrail_app.project-fixture:fixture@aws-0-fixture.pooler.supabase.com/postgres",
    ]) expect(postgresProject(value)).toBe("project-fixture");
  });
  it("supports direct and pooled connections with strict TLS and unprepared queries", () => {
    for (const hostname of ["db.fixture.supabase.co", "aws-0-fixture.pooler.supabase.com"]) {
      const url = `postgresql://synthetic:fixture-password@${hostname}:6543/postgres`;
      expect(readPostgresUrl(url)).toBe(url);
    }
    expect(postgresOptions()).toMatchObject({
      prepare: false,
      max: 1,
      max_pipeline: 1,
      ssl: { rejectUnauthorized: true },
    });
  });
  it("adds a configured CA while keeping Node's trust store and strict TLS", () => {
    const directory = mkdtempSync(join(tmpdir(), "monitrail-ca-"));
    const caFile = join(directory, "ca.crt");
    try {
      const roots = getCACertificates();
      writeFileSync(caFile, roots[0]);
      const { ssl } = postgresOptions(caFile);
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca?.slice(0, -1)).toEqual(roots);
      expect(new X509Certificate(ssl.ca?.at(-1) ?? "").fingerprint256).toBe(
        new X509Certificate(roots[0]).fingerprint256,
      );
      writeFileSync(caFile, "invalid certificate");
      expect(() => postgresOptions(caFile)).toThrow("Configure a valid Supabase CA certificate file.");
      expect(() => postgresOptions(join(directory, "missing.crt"))).toThrow(
        "Configure a valid Supabase CA certificate file.",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("accepts only the restricted role on the transaction pooler at runtime", () => {
    const url = "postgresql://monitrail_app.fixture:synthetic@aws-0-fixture.pooler.supabase.com:6543/postgres";
    expect(readRuntimePostgresUrl(url)).toBe(url);
    for (const invalid of [url.replace("monitrail_app.", "postgres."), url.replace("6543", "5432")])
      expect(() => readRuntimePostgresUrl(invalid)).toThrow("restricted PostgreSQL runtime role");
  });
  it.each([
    undefined,
    "https://example.invalid",
    "postgresql://synthetic:fixture@example.invalid/db",
    "postgresql://synthetic@db.fixture.supabase.co/postgres",
    "postgresql://synthetic:fixture@db.fixture.supabase.co/postgres?host=outside.invalid",
    "postgresql://synthetic:fixture@outside.invalid,db.fixture.supabase.co/postgres",
  ])("rejects an invalid destination without echoing it", (value) => {
    expect(() => readPostgresUrl(value)).toThrow(
      "Configure a Supabase PostgreSQL connection in the local environment.",
    );
  });
});
