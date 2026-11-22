import { lstat, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { postgresAccess } from "../../src/db/postgres-access.ts";
import { postgresOptions, readPostgresUrl } from "../../src/db/postgres-config.ts";
import { createDogfoodEvidenceCapability, validateDogfoodEvidenceInput, type DogfoodEvidenceInput } from "../../src/services/dogfood-evidence.ts";

const checkout = fileURLToPath(new URL("../../../", import.meta.url));

export function parseExportArguments(args: string[]): DogfoodEvidenceInput & { output: string } {
  if (args[0] !== "--confirm-export-private-evidence" || args.length !== 9) throw new Error();
  const allowed = new Set(["--monitors", "--from", "--to", "--output"]);
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!allowed.has(key) || values.has(key) || !value || value.startsWith("--")) throw new Error();
    values.set(key, value);
  }
  const output = values.get("--output");
  if (!output || !isAbsolute(output) || extname(output) !== ".json" || /[\r\n\0]/.test(output)) throw new Error();
  const input = validateDogfoodEvidenceInput({ monitorIds: values.get("--monitors")?.split(","), from: values.get("--from"), to: values.get("--to") });
  return { ...input, output };
}

async function privateOutputPath(output: string): Promise<string> {
  if (!isAbsolute(output) || extname(output) !== ".json" || /[\r\n\0]/.test(output)) throw new Error();
  const path = resolve(await realpath(dirname(output)), output.slice(output.lastIndexOf("/") + 1));
  const inside = relative(await realpath(checkout), path);
  if (!inside.startsWith("../") && inside !== "..") throw new Error();
  try { await lstat(path); throw new Error(); }
  catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw new Error();
  }
  return path;
}

/** Snapshots stay outside the checkout and existing paths, including symlinks, are refused. */
export async function writePrivateEvidence(output: string, value: unknown): Promise<void> {
  const path = await privateOutputPath(output);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
}

async function main() {
  let client: ReturnType<typeof postgres> | undefined;
  try {
    const { output, ...input } = parseExportArguments(process.argv.slice(2));
    await privateOutputPath(output);
    const adminUrl = readPostgresUrl(process.env.MIGRATION_DATABASE_URL);
    if (!["", "5432"].includes(new URL(adminUrl).port)) throw new Error();
    client = postgres(adminUrl, postgresOptions());
    const result = await createDogfoodEvidenceCapability(postgresAccess(drizzle(client))).exportDogfoodEvidence(input);
    await writePrivateEvidence(output, result);
    console.log(`Private dogfood evidence exported. Monitors: ${result.monitors.length}. Checks: ${result.checks.length}. Missing acceptance records: ${result.missingAcceptanceEvidence}.`);
  } catch {
    console.error("Dogfood evidence export failed. Check the target, bounded window, confirmation and new private output path. Raw errors and credentials were suppressed.");
    process.exitCode = 1;
  } finally {
    try { await client?.end({ timeout: 5 }); }
    catch {
      console.error("Evidence database connection could not close cleanly.");
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
