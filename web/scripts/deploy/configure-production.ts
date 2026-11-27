import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { identity } from "../../../shared/identity.ts";
import { validateDatabaseCaPem } from "../../src/db/postgres-config.ts";
import { assertNoStaleRuntimeKeys, prepareProductionEnvironment, serializePrivateEnvironment } from "../../src/ops/production-environment.ts";

const web = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const productionFile = new URL("../../.env.production.local", import.meta.url);

export function parseConfigureArguments(args: readonly string[]) {
  const flags = new Set<string>();
  const settings: Record<string, string> = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (flags.has(key)) throw new Error();
    flags.add(key);
    if (key === "--origin" || key === "--abuse-contact" || key === "--proof-monitor-ids") {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error();
      settings[key] = value;
    } else if (!["--reuse-oauth-apps", "--enable-proof-capture", "--upload", "--prepare-only"].includes(key)) throw new Error();
  }
  if (!settings["--origin"] || !settings["--abuse-contact"] || flags.has("--upload") === flags.has("--prepare-only")) throw new Error();
  const proofMonitorIds = settings["--proof-monitor-ids"];
  if (proofMonitorIds !== undefined && !flags.has("--enable-proof-capture")) throw new Error();
  return {
    origin: settings["--origin"], abuseContact: settings["--abuse-contact"],
    proofCapture: flags.has("--enable-proof-capture"), reuseOAuth: flags.has("--reuse-oauth-apps"), upload: flags.has("--upload"),
    ...(proofMonitorIds !== undefined ? { proofMonitorIds } : {}),
  };
}

/** Only the explicit local operator selection may replace the saved export scope. */
export function prepareConfiguredProductionEnvironment(
  existing: Readonly<Record<string, string | undefined>>,
  options: ReturnType<typeof parseConfigureArguments>,
  development?: Readonly<Record<string, string | undefined>>,
) {
  if (options.proofMonitorIds !== undefined && (!options.proofCapture || !options.proofMonitorIds)) throw new Error("Production settings are invalid.");
  const selected = options.proofMonitorIds === undefined
    ? existing
    : { ...existing, DOGFOOD_EXPORT_MONITOR_IDS: options.proofMonitorIds };
  return prepareProductionEnvironment(selected, options, development);
}

export async function readPrivateConfiguration(file: URL) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 262_144 || (process.getuid && info.uid !== process.getuid())) throw new Error();
    await handle.chmod(0o600);
    return { content: await handle.readFile("utf8"), info };
  } finally {
    await handle.close();
  }
}

export async function savePrivateConfiguration(file: URL, original: Awaited<ReturnType<typeof readPrivateConfiguration>>, values: Record<string, string>) {
  const current = await lstat(file);
  if (!current.isFile() || current.isSymbolicLink() || current.ino !== original.info.ino || current.mtimeMs !== original.info.mtimeMs || current.size !== original.info.size) throw new Error();
  const temporary = new URL(`${file.href}.config-pending`);
  let created = false;
  try {
    await writeFile(temporary, serializePrivateEnvironment(values), { mode: 0o600, flag: "wx" });
    created = true;
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

export function cliEnvironment(provider: "vercel" | "github" = "vercel", ambient: Readonly<Record<string, string | undefined>> = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", VERCEL_TELEMETRY_DISABLED: "1", NO_UPDATE_NOTIFIER: "1" };
  const credentials = provider === "vercel" ? ["VERCEL_TOKEN", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"] : ["GH_CONFIG_DIR", "GH_HOST", "GH_TOKEN", "GITHUB_TOKEN"];
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "NO_COLOR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", ...credentials]) {
    if (ambient[name]) env[name] = ambient[name];
  }
  return env;
}

export function parseConfiguredProductionKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || !("envs" in value) || !Array.isArray(value.envs)) throw new Error();
  if ("pagination" in value && value.pagination !== undefined && value.pagination !== null) {
    const pagination = value.pagination;
    if (typeof pagination !== "object" || Array.isArray(pagination) ||
      ("next" in pagination && pagination.next !== null && pagination.next !== undefined)) throw new Error();
  }
  if (value.envs.some((item: { key?: unknown; target?: unknown }) => !item || typeof item !== "object" || typeof item.key !== "string" || !Array.isArray(item.target))) throw new Error();
  return value.envs.filter((item: { target: string[] }) => item.target.includes("production")).map((item: { key: string }) => item.key);
}

async function configuredProductionKeys(link: { projectId: string; orgId: string }): Promise<string[]> {
  const child = spawn("vercel", ["api", `/v9/projects/${link.projectId}/env?teamId=${link.orgId}&target=production`, "--raw"], {
    cwd: repository, env: cliEnvironment(), stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  });
  let body = "";
  child.stdout.on("data", (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > 1_048_576) child.kill();
  });
  child.stderr.resume();
  await new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error()));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error()));
  });
  return parseConfiguredProductionKeys(JSON.parse(body));
}

async function uploadVariable(key: string, value: string) {
  const child = spawn("vercel", ["env", "add", key, "production", "--sensitive", "--force", "--yes", "--cwd", repository], {
    cwd: repository,
    env: cliEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
  });
  child.stdout.resume();
  child.stderr.resume();
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error()));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error()));
    child.stdin.on("error", () => {});
  });
  child.stdin.end(value);
  await completion;
}

async function uploadProofSecret(key: "DOGFOOD_EXPORT_HMAC_SECRET" | "DOGFOOD_PROOF_KEY", value: string) {
  const source = new URL(identity.sourceRepository);
  if (source.origin !== "https://github.com" || !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.pathname) || source.search || source.hash) throw new Error();
  const child = spawn("gh", ["secret", "set", key, "--repo", source.pathname.slice(1)], {
    cwd: repository, env: cliEnvironment("github"), stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  });
  child.stdout.resume();
  child.stderr.resume();
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new Error()));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error()));
    child.stdin.on("error", () => {});
  });
  child.stdin.end(value);
  await completion;
}

/** Run by the owner locally; secret-file guards may prohibit agent execution. */
export async function configureProduction(args: readonly string[]) {
  const options = parseConfigureArguments(args);
  const original = await readPrivateConfiguration(productionFile);
  const existing = parseEnv(original.content);
  if (existing.DATABASE_CA_PEM && existing.DATABASE_CA_FILE) throw new Error();
  let development: Record<string, string | undefined> | undefined;
  if (options.reuseOAuth) development = parseEnv((await readPrivateConfiguration(new URL("../../.env.local", import.meta.url))).content);
  const prepared = prepareConfiguredProductionEnvironment(existing, options, development);
  let caPem = existing.DATABASE_CA_PEM;
  if (!caPem) {
    try { caPem = await readFile(resolve(web, existing.DATABASE_CA_FILE ?? ".certs/supabase-ca.crt"), "utf8"); }
    catch (error) {
      if (existing.DATABASE_CA_FILE || !(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error();
    }
  }
  if (caPem) {
    caPem = validateDatabaseCaPem(caPem);
    // Keep a local file setting when present; the hosted runtime receives only PEM.
    prepared.runtime.DATABASE_CA_PEM = caPem;
  }
  if (Buffer.byteLength(JSON.stringify(prepared.runtime), "utf8") > 60_000) throw new Error();
  if (options.upload) {
    const link = JSON.parse(await readFile(new URL("../../../.vercel/project.json", import.meta.url), "utf8"));
    if (link.projectName !== identity.brandName.toLowerCase() || !/^prj_[A-Za-z0-9]+$/.test(link.projectId) || !/^team_[A-Za-z0-9]+$/.test(link.orgId)) throw new Error();
    assertNoStaleRuntimeKeys(await configuredProductionKeys(link), prepared.runtime);
  }
  await savePrivateConfiguration(productionFile, original, prepared.saved);
  if (options.upload) {
    for (const [key, value] of Object.entries(prepared.runtime)) await uploadVariable(key, value);
    if (options.proofCapture) {
      await uploadProofSecret("DOGFOOD_EXPORT_HMAC_SECRET", prepared.saved.DOGFOOD_EXPORT_HMAC_SECRET);
      await uploadProofSecret("DOGFOOD_PROOF_KEY", prepared.saved.DOGFOOD_PROOF_KEY);
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await configureProduction(process.argv.slice(2));
    console.log("Production settings prepared successfully. Requested uploads use production-only secret variables. No secret values were displayed.");
  } catch {
    console.error("Production settings preparation failed. Check the local configuration, project link and Vercel access privately. No secret values or raw errors were displayed.");
    process.exitCode = 1;
  }
}
