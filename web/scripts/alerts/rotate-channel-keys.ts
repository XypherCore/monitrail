import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createChannelCipher } from "../../src/alerts/channel-crypto.ts";
import { rotateChannelKeys } from "../../src/alerts/key-rotation.ts";
import { postgresAccess } from "../../src/db/postgres-access.ts";
import {
  postgresOptions,
  postgresProject,
  readPostgresUrl,
  readRuntimePostgresUrl,
} from "../../src/db/postgres-config.ts";

let client: ReturnType<typeof postgres> | undefined;
try {
  if (process.argv.length !== 3 || process.argv[2] !== "--confirm-rotate-channel-keys") throw new Error();
  if (!process.env.CHANNEL_ENC_PREVIOUS_KEY || !process.env.CHANNEL_ENC_PREVIOUS_KEY_ID) throw new Error();
  const cipher = createChannelCipher();
  const runtimeUrl = readRuntimePostgresUrl(process.env.DATABASE_URL);
  const adminUrl = readPostgresUrl(process.env.MIGRATION_DATABASE_URL);
  if (
    postgresProject(runtimeUrl) !== postgresProject(adminUrl) ||
    new URL(runtimeUrl).pathname !== new URL(adminUrl).pathname ||
    !["", "5432"].includes(new URL(adminUrl).port)
  ) throw new Error();
  client = postgres(adminUrl, postgresOptions());
  const count = await rotateChannelKeys(postgresAccess(drizzle(client)), cipher);
  console.log(`Channel key rotation completed. Rows updated: ${count}.`);
} catch {
  console.error("Channel key rotation failed. Check the target, keys and explicit confirmation.");
  process.exitCode = 1;
} finally {
  try {
    await client?.end({ timeout: 5 });
  } catch {
    console.error("Channel rotation database connection could not close cleanly.");
    process.exitCode = 1;
  }
}
