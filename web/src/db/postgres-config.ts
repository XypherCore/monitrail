import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { getCACertificates } from "node:tls";

export function readPostgresUrl(value: string | undefined): string {
  try {
    const parsed = new URL(value ?? "");
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.username ||
      !parsed.password ||
      parsed.hash ||
      parsed.searchParams.has("host") ||
      parsed.searchParams.has("port") ||
      !(
        /^db\.[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname) ||
        /^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(parsed.hostname)
      )
    ) {
      throw new Error();
    }
    return parsed.href;
  } catch {
    throw new Error("Configure a Supabase PostgreSQL connection in the local environment.");
  }
}

/** Normalize one bounded public CA without consulting runtime configuration. */
export function validateDatabaseCaPem(caPem: string): string {
  try {
    if (Buffer.byteLength(caPem, "utf8") > 65_536 ||
      !/^\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(caPem)) throw new Error();
    const certificate = new X509Certificate(caPem);
    if (!certificate.ca) throw new Error();
    return certificate.toString();
  } catch {
    throw new Error("Configure a valid Supabase CA certificate PEM.");
  }
}

export function postgresOptions(
  caFile = process.env.DATABASE_CA_FILE,
  caPem = process.env.DATABASE_CA_PEM,
) {
  let ca: string[] | undefined;
  if (caPem !== undefined) {
    if (caFile !== undefined) throw new Error("Configure only one Supabase CA certificate source.");
    ca = [...getCACertificates(), validateDatabaseCaPem(caPem)];
  } else {
    try {
      const certificate = new X509Certificate(readFileSync(caFile ?? ".certs/supabase-ca.crt"));
      if (!certificate.ca) throw new Error();
      ca = [...getCACertificates(), certificate.toString()];
    } catch (error) {
      if (
        caFile !== undefined ||
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw new Error("Configure a valid Supabase CA certificate file.");
      }
    }
  }
  return {
    prepare: false,
    max: 1,
    // Keep a transaction-pooler connection on one unnamed statement at a time.
    max_pipeline: 1,
    debug: false,
    ssl: { rejectUnauthorized: true, ca },
    connect_timeout: 10,
    idle_timeout: 20,
    onnotice: () => {},
  };
}

export function postgresProject(value: string | undefined): string {
  const connection = new URL(readPostgresUrl(value));
  const direct = /^db\.([a-z0-9-]+)\.supabase\.co$/i.exec(connection.hostname);
  if (direct) return direct[1].toLowerCase();
  const pooled = /^[^.]+\.([a-z0-9-]+)$/i.exec(decodeURIComponent(connection.username));
  if (connection.hostname.endsWith(".pooler.supabase.com") && pooled) return pooled[1].toLowerCase();
  throw new Error("The Supabase project identity is unavailable.");
}

export function readRuntimePostgresUrl(value: string | undefined): string {
  const url = readPostgresUrl(value);
  const target = new URL(url);
  if (
    !target.hostname.endsWith(".pooler.supabase.com") ||
    target.port !== "6543" ||
    target.username !== `monitrail_app.${postgresProject(url)}`
  ) {
    throw new Error("Configure the restricted PostgreSQL runtime role through the transaction pooler.");
  }
  return url;
}
