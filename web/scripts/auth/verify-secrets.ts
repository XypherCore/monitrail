import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Complement pattern-based scans with the actual configured values in memory.
// Neither values nor matching text are ever printed, including on failure.
try {
  const root = new URL("../../../", import.meta.url);
  const env = parseEnv(await readFile(new URL("../../.env.local", import.meta.url), "utf8"));
  const names = ["DATABASE_URL", "AUTH_SECRET", "AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"];
  const values = names.map(name => env[name]).filter((value): value is string => Boolean(value && value.length >= 12));
  if (values.length < 4) throw new Error();
  const eligible = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root }).toString().split("\0").filter(Boolean);
  if (eligible.some(path => path.split("/").some(part => part.startsWith(".env") && part !== ".env.example"))) throw new Error();
  let scanned = 0;
  let leaked = false;
  async function scan(path: URL) {
    const data = await readFile(path);
    scanned++;
    if (values.some(value => data.includes(Buffer.from(value)))) leaked = true;
  }
  for (const path of eligible) await scan(new URL(path, root));
  async function scanBrowser(path: URL): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), path);
      if (entry.isDirectory()) await scanBrowser(child);
      else if (entry.isFile()) await scan(child);
    }
  }
  await scanBrowser(new URL("../../.next/static/", import.meta.url));
  if (leaked) throw new Error();
  // The local secret file itself must remain ignored.
  execFileSync("git", ["check-ignore", "--quiet", fileURLToPath(new URL("../../.env.local", import.meta.url))], { cwd: root });
  console.log(`Configured credential scan passed across ${scanned} Git-eligible and built browser files; no values were displayed.`);
} catch {
  console.error("Configured credential scan failed or was incomplete; inspect privately. No secret values or matching content were displayed.");
  process.exitCode = 1;
}
