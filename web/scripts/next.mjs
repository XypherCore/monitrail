import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Next.js forwards Node CLI flags to its dev worker through NODE_OPTIONS.
// Load the local runtime environment before starting the CLI instead.
try {
  const local = parseEnv(readFileSync(new URL("../.env.phase3b.local", import.meta.url), "utf8"));
  for (const [name, value] of Object.entries(local)) {
    if (name !== "MIGRATION_DATABASE_URL" && name !== "NODE_OPTIONS") {
      process.env[name] ??= value;
    }
  }
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.error("Unable to load the local web runtime environment.");
    process.exit(1);
  }
}
delete process.env.MIGRATION_DATABASE_URL;

const nextCli = import.meta.resolve("next/dist/bin/next");
process.argv[1] = fileURLToPath(nextCli);
await import(nextCli);
