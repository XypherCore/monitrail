import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import type postgres from "postgres";
import { postgresProject, readPostgresUrl } from "../../src/db/postgres-config.ts";

export const applicationTables = [
  "users",
  "accounts",
  "sessions",
  "invites",
  "monitors",
  "check_attempts",
  "checks",
  "monitor_events",
  "incidents",
  "alert_channels",
  "telegram_link_codes",
  "monitor_alert_channels",
  "alert_outbox",
  "status_pages",
  "status_page_monitors",
  "slug_tombstones",
  "blocked_hosts",
  "rate_limits",
  "system_heartbeat",
];

function scramVerifier(password: string): string {
  // PostgreSQL accepts the RFC 7677 verifier, so role DDL carries no login password.
  const salt = randomBytes(16);
  const iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256${"$"}${iterations}:${salt.toString("base64")}${"$"}${stored}:${server}`;
}

async function verifyGrants(query: postgres.Sql | postgres.TransactionSql) {
  const [permissions] = await query`WITH app_tables AS (
    SELECT 'public.' || name AS name
    FROM jsonb_array_elements_text(${JSON.stringify(applicationTables)}::jsonb) AS t(name)
  ), api_roles(name) AS (VALUES ('anon'), ('authenticated'), ('service_role'))
  SELECT
    has_schema_privilege('monitrail_app','public','USAGE') AND
    NOT has_schema_privilege('monitrail_app','public','CREATE') AND
    has_sequence_privilege('monitrail_app','public.checks_id_seq','USAGE') AND
    has_sequence_privilege('monitrail_app','public.checks_id_seq','SELECT') AND
    NOT has_sequence_privilege('monitrail_app','public.checks_id_seq','UPDATE') AND
    NOT EXISTS (SELECT 1 FROM app_tables WHERE
      NOT has_table_privilege('monitrail_app',name,'SELECT') OR
      NOT has_table_privilege('monitrail_app',name,'INSERT') OR
      NOT has_table_privilege('monitrail_app',name,'UPDATE') OR
      NOT has_table_privilege('monitrail_app',name,'DELETE') OR
      has_table_privilege('monitrail_app',name,'TRUNCATE,REFERENCES,TRIGGER')) AND
    NOT EXISTS (SELECT 1 FROM api_roles r CROSS JOIN app_tables t WHERE
      has_table_privilege(r.name,t.name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_sequence_privilege(r.name,'public.checks_id_seq','USAGE,SELECT,UPDATE')) AS valid`;
  if (permissions.valid !== true) throw new Error("Application role permissions are invalid.");
}

/** Administrative capability for the approved fresh project only. */
export async function configureApplicationRole(
  client: ReturnType<typeof postgres>,
  environmentFile = new URL("../../.env.phase3b.local", import.meta.url),
) {
  const runtime = new URL(readPostgresUrl(process.env.DATABASE_URL));
  const username = decodeURIComponent(runtime.username);
  const appUsername = `monitrail_app.${postgresProject(runtime.href)}`;
  const target = environmentFile;
  if (target.protocol !== "file:") throw new Error("Runtime environment entry is ambiguous.");
  const content = await readFile(target, "utf8");
  const saved = parseEnv(content);
  if (
    (content.match(/^DATABASE_URL=/gm) ?? []).length !== 1 ||
    readPostgresUrl(saved.DATABASE_URL) !== runtime.href ||
    readPostgresUrl(saved.MIGRATION_DATABASE_URL) !== readPostgresUrl(process.env.MIGRATION_DATABASE_URL)
  ) {
    throw new Error("Runtime environment entry is ambiguous.");
  }
  const [existing] =
    await client`SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication FROM pg_roles
    WHERE rolname='monitrail_app'`;
  if (
    existing &&
    (!existing.rolcanlogin || existing.rolsuper || existing.rolcreatedb ||
      existing.rolcreaterole || existing.rolbypassrls || existing.rolreplication)
  ) {
    throw new Error("Unexpected application-role privileges.");
  }
  const memberships = await client`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member
    WHERE r.rolname='monitrail_app'`;
  if (memberships.length) throw new Error("Unexpected application-role membership.");
  if (existing) {
    if (username !== appUsername)
      throw new Error("An existing role requires its saved runtime credential.");
    await verifyGrants(client);
    return;
  }
  const password = randomBytes(32).toString("base64url");
  const temporary = new URL(`${target.href}.pending`);
  runtime.username = appUsername;
  runtime.password = password;
  const updated = content.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${runtime.href}`);
  await client.begin(async (transaction) => {
    const verifier = scramVerifier(password);
    const [statement] =
      await transaction`SELECT format('CREATE ROLE monitrail_app LOGIN NOINHERIT PASSWORD %L',${verifier}::text) AS command`;
    await transaction.unsafe(statement.command);
    await transaction`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    await transaction`GRANT USAGE ON SCHEMA public TO monitrail_app`;
    for (const table of applicationTables) {
      await transaction`REVOKE ALL ON TABLE public.${transaction(table)}
        FROM PUBLIC,anon,authenticated,service_role`;
      await transaction`GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.${transaction(table)}
        TO monitrail_app`;
    }
    await transaction`REVOKE ALL ON SEQUENCE public.checks_id_seq
      FROM PUBLIC,anon,authenticated,service_role`;
    await transaction`GRANT USAGE,SELECT ON SEQUENCE public.checks_id_seq TO monitrail_app`;
    await verifyGrants(transaction);
    // A failed write rolls back the new role. A post-commit rename failure leaves
    // this ignored recovery file, and never changes an existing role's password.
    await writeFile(temporary, updated, { mode: 0o600, flag: "wx" });
  });
  await rename(temporary, target);
  process.env.DATABASE_URL = runtime.href;
}
