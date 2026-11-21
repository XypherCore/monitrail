import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const localFiles = [
  "web/.env.local",
  "web/.env.phase3b.local",
  "web/.env.phase3b.local.pending",
  "web/.env.invite.local",
  "checker/.dev.vars",
];
const credentialNames = [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "AUTH_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "INTERNAL_HMAC_SECRET",
  "INGEST_HMAC_SECRET",
  "CHANNEL_ENC_KEY",
  "CHANNEL_ENC_PREVIOUS_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "INVITE_CODE",
];

async function configuredValues(): Promise<Set<string>> {
  const values = new Set<string>();
  if (process.env.CI === "true") {
    for (const name of credentialNames) {
      const value = process.env[name];
      if (value && value.length >= 12) values.add(value);
    }
  }
  for (const file of process.env.CI === "true" ? [] : localFiles) {
    try {
      const env = parseEnv(await readFile(resolve(root, file), "utf8"));
      for (const name of credentialNames) {
        const value = env[name];
        if (!value || value.length < 12) continue;
        values.add(value);
        if (name === "DATABASE_URL" || name === "MIGRATION_DATABASE_URL") {
          const encoded = new URL(value).password;
          for (const password of [encoded, decodeURIComponent(encoded)]) {
            if (password.length >= 12) values.add(password);
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  if (values.size < 4 || [...values].some(value => /[\r\n\0]/.test(value))) throw new Error();
  return values;
}

function gitOutput(args: string[]): string {
  return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function gitGrep(args: string[], patterns: string): void {
  const result = spawnSync("git", ["grep", "-a", "-F", "-q", "-f", "-", ...args], {
    cwd: root,
    input: patterns,
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (result.status !== 1) throw new Error();
}

function isCredentialFile(path: string): boolean {
  return path.split("/").some(part =>
    part !== ".env.example" &&
    (part === ".env" || part.startsWith(".env.") || part === ".dev.vars" || part.startsWith(".dev.vars."))
  );
}

async function scanBrowser(path: string, scan: (file: string) => Promise<void>): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) await scanBrowser(child, scan);
    else if (entry.isFile()) await scan(child);
  }
}

// Complement pattern-based scanning with configured values held in memory.
// Never print values, matched content, Git output or parse errors.
try {
  for (const file of localFiles) gitOutput(["check-ignore", "--quiet", file]);
  const eligible = gitOutput(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean);
  const historicalPaths = gitOutput(["log", "--all", "HEAD", "--format=", "--name-only", "-z", "--",
    ":(glob)**/.env*", ":(glob)**/.dev.vars*"]).split("\0");
  if (eligible.some(isCredentialFile) || historicalPaths.some(isCredentialFile)) throw new Error();

  const values = [...await configuredValues()];
  const patterns = `${values.join("\n")}\n`;
  gitGrep(["--cached"], patterns);
  const commits = gitOutput(["rev-list", "--all", "HEAD"]).trim().split("\n");
  for (let offset = 0; offset < commits.length; offset += 100) {
    gitGrep([...commits.slice(offset, offset + 100), "--"], patterns);
  }
  const needles = values.map(value => Buffer.from(value));
  let scanned = 0;
  async function scan(path: string) {
    const data = await readFile(path);
    if (needles.some(needle => data.includes(needle))) throw new Error();
    scanned++;
  }
  for (const path of eligible) {
    try {
      await scan(resolve(root, path));
    } catch (error) {
      // The index and history scans already cover tracked files removed on disk.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  await scanBrowser(resolve(root, "web/.next/static"), scan);
  console.log(
    `Configured credential scan passed across ${scanned} Git-eligible and built browser files, the Git index, and ${commits.length} reachable commits.`,
  );
} catch {
  console.error("Configured credential scan failed or was incomplete; inspect privately. No secret values or matching content were displayed.");
  process.exitCode = 1;
}
