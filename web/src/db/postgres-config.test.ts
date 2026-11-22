import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  postgresOptions,
  postgresProject,
  readPostgresUrl,
  readRuntimePostgresUrl,
  validateDatabaseCaPem,
} from "./postgres-config.ts";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

// Public synthetic leaf certificate, deliberately not a certificate authority.
const leafCertificate = `-----BEGIN CERTIFICATE-----
MIIBiTCCATCgAwIBAgIUQGCZFQhb8qBvDrf+BUcNlNSXZL4wCgYIKoZIzj0EAwIw
HDEaMBgGA1UEAwwRc3ludGhldGljLmludmFsaWQwHhcNMjYxMTIyMDU0OTAyWhcN
MjYxMTIzMDU0OTAyWjAcMRowGAYDVQQDDBFzeW50aGV0aWMuaW52YWxpZDBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABCUpHapBBuPcA6zxa25HZ3Kf7iypAYxDGzqd
X8L8N6rBJOU1QM1itBkSPG7aMSx/XlcQeFZ0YXuL5Ph9BblQBhKjUDBOMB0GA1Ud
DgQWBBS964dFnfgh41h/pijJR53iSZiChzAfBgNVHSMEGDAWgBS964dFnfgh41h/
pijJR53iSZiChzAMBgNVHRMBAf8EAjAAMAoGCCqGSM49BAMCA0cAMEQCIETF9a99
+30cV+NWOIHDUlvkVHIkyII4IehZh71P93PhAiAB6ExwdurD4v7Dn5O83k9dHIPx
C/8U5jifAXEAVmt9kQ==
-----END CERTIFICATE-----`;

describe("Supabase PostgreSQL configuration", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_CA_FILE", undefined);
    vi.stubEnv("DATABASE_CA_PEM", undefined);
    vi.mocked(readFileSync).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());
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
  it("accepts a bounded CA PEM without reading files and preserves Node's trust store", () => {
    const roots = getCACertificates();
    for (const pem of [roots[0], roots[0].replaceAll("\n", "\r\n")]) {
      const { ssl } = postgresOptions(undefined, pem);
      expect(ssl.rejectUnauthorized).toBe(true);
      expect(ssl.ca?.slice(0, -1)).toEqual(roots);
      expect(new X509Certificate(ssl.ca?.at(-1) ?? "").fingerprint256).toBe(new X509Certificate(roots[0]).fingerprint256);
    }
    const bounded = `${roots[0]}${" ".repeat(65536 - Buffer.byteLength(roots[0], "utf8"))}`;
    expect(postgresOptions(undefined, bounded).ssl.rejectUnauthorized).toBe(true);
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("supports a configured environment PEM without requiring an ignored file", () => {
    vi.stubEnv("DATABASE_CA_PEM", getCACertificates()[0]);
    expect(postgresOptions().ssl.ca).toHaveLength(getCACertificates().length + 1);
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("validates and normalizes a PEM independently of ambient file and PEM configuration", () => {
    vi.stubEnv("DATABASE_CA_FILE", "private-fixture-do-not-read.crt");
    vi.stubEnv("DATABASE_CA_PEM", "private-fixture-invalid-ambient-value");
    const root = getCACertificates()[0];
    expect(validateDatabaseCaPem(root.replaceAll("\n", "\r\n"))).toBe(new X509Certificate(root).toString());
    expect(() => validateDatabaseCaPem("private-fixture-invalid-certificate")).toThrow("Configure a valid Supabase CA certificate PEM.");
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("rejects ambiguous file and PEM sources before accessing either one", () => {
    expect(() => postgresOptions("certificate.crt", getCACertificates()[0])).toThrow("Configure only one Supabase CA certificate source.");
    vi.stubEnv("DATABASE_CA_FILE", "certificate.crt");
    vi.stubEnv("DATABASE_CA_PEM", getCACertificates()[0]);
    expect(() => postgresOptions()).toThrow("Configure only one Supabase CA certificate source.");
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("rejects malformed, non-CA, oversized and combined PEM input without echoing it", () => {
    const root = getCACertificates()[0];
    for (const pem of ["", "private-fixture-invalid-certificate", leafCertificate, "x".repeat(65537), `${root}${" ".repeat(65536)}`, `${root}\n${root}`, `${root}\nprivate-fixture-unexpected-suffix`]) {
      expect(() => postgresOptions(undefined, pem)).toThrow("Configure a valid Supabase CA certificate PEM.");
    }
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it("keeps the existing optional default-file behavior when neither CA source is configured", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("missing fixture"), { code: "ENOENT" }); });
    expect(postgresOptions(undefined, undefined).ssl).toEqual({ rejectUnauthorized: true, ca: undefined });
    expect(readFileSync).toHaveBeenCalledWith(".certs/supabase-ca.crt");
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
