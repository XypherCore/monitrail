import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { postgresAccess } from "../../src/db/postgres-access.ts";
import { postgresOptions, readPostgresUrl } from "../../src/db/postgres-config.ts";
import { createBlocklistCapability, parseBlockHostArguments } from "../../src/services/blocklist.ts";

let client: ReturnType<typeof postgres> | undefined;
try {
  const { apply, command } = parseBlockHostArguments(process.argv.slice(2));
  if (!apply) {
    console.log("Blocklist command validated. No database changes made.");
  } else {
    const connection = readPostgresUrl(process.env.MIGRATION_DATABASE_URL);
    const target = new URL(connection);
    // Administrative work uses a direct or session-pooler connection.
    if (!["", "5432"].includes(target.port) || decodeURIComponent(target.username).split(".")[0] === "monitrail_app") throw new Error();
    client = postgres(connection, postgresOptions());
    const access = createBlocklistCapability(postgresAccess(drizzle(client)), { domainControlVerified: true });
    await access.manageBlocklist(command);
    console.log("Blocklist update completed. Existing monitors are evaluated by the next claim or maintenance run.");
  }
} catch {
  console.error("Blocklist command was refused. Use add or remove, a hostname, and --dry-run or --apply --confirm-domain-control. Check the administrative connection privately.");
  process.exitCode = 1;
} finally {
  try {
    await client?.end({ timeout: 5 });
  } catch {
    console.error("Blocklist connection cleanup failed.");
    process.exitCode = 1;
  }
}
