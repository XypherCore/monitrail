import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const webDirectory = fileURLToPath(new URL("../../", import.meta.url));

export async function applyMigrationsWithKit(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  // Keep raw CLI output private: dependency errors may print connection strings.
  // Only the trusted committed migrations are passed; no arbitrary SQL arguments.
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/drizzle-kit/bin.cjs", import.meta.url)),
    "migrate", "--config=drizzle.config.ts",
  ], { cwd: webDirectory, env: process.env, timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.resume();
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error("Migration process could not start.")));
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error("Migration process failed."));
    });
  });
}
