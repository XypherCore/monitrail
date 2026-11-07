import { createHash, randomBytes } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import postgres from "postgres";
import { postgresOptions, readRuntimePostgresUrl } from "../../src/db/postgres-config.ts";

let client: ReturnType<typeof postgres> | undefined;
let wrote = false;
const destination = new URL("../../.env.invite.local", import.meta.url);
try {
  if (!process.argv.includes("--confirm-invite") || process.env.NODE_ENV === "production")
    throw new Error();
  client = postgres(readRuntimePostgresUrl(process.env.DATABASE_URL), postgresOptions());
  const code = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(code).digest("hex");
  await client.begin(async (transaction) => {
    await transaction`INSERT INTO invites(code_hash) VALUES (${hash})`;
    await writeFile(destination, `INVITE_CODE=${code}\n`, { mode: 0o600, flag: "wx" });
    wrote = true;
  });
  console.log(
    "Single-use invite saved in the ignored web/.env.invite.local file. Open that file locally to use it.",
  );
} catch {
  if (wrote) await unlink(destination).catch(() => {});
  console.error(
    "Invite creation failed. The output file must be absent and the runtime database configured.",
  );
  process.exitCode = 1;
} finally {
  try {
    await client?.end({ timeout: 5 });
  } catch {
    process.exitCode = 1;
  }
}
