import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import postgres from "postgres";
import { identity } from "../../../shared/identity.ts";
import { parseWebhookTarget } from "../../../shared/ssrf/address.ts";
import { isBlockedHost } from "../../../shared/ssrf/blocklist.ts";
import { isTelegramWebhookSecret } from "../../src/alerts/channel-input.ts";
import { isTelegramBotToken } from "../../src/alerts/telegram-target.ts";
import { postgresOptions, postgresProject, readPostgresUrl, readRuntimePostgresUrl } from "../../src/db/postgres-config.ts";
import { createWebGuard } from "../../src/security/web-ssrf.ts";
import { readPrivateConfiguration } from "./configure-production.ts";

type Environment = Readonly<Record<string, string | undefined>>;
type Operation = { uploadCheckerKey: boolean; registerTelegram: boolean };
type ServiceSettings = {
  origin: string;
  signingKey: string;
  botToken?: string;
  webhookSecret?: string;
  adminUrl?: string;
  databaseOptions?: ReturnType<typeof postgresOptions>;
};
export type WranglerInvocation = {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
};
type Registration = { register(): Promise<unknown>; close(): Promise<void> };
type Dependencies = {
  environment: Environment;
  readConfiguration(file: URL): Promise<{ content: string }>;
  readWorkerConfiguration(file: URL): Promise<string>;
  execute(command: WranglerInvocation): Promise<string>;
  registration(settings: ServiceSettings, saved: Environment): Promise<Registration>;
};

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const web = fileURLToPath(new URL("../../", import.meta.url));
const productionFile = new URL("../../.env.production.local", import.meta.url);
const workerFile = new URL("../../../checker/wrangler.jsonc", import.meta.url);
const workerName = `${identity.brandName.toLowerCase()}-checker`;
const invalid = () => new Error("Service connection settings are invalid.");
const failureMessages = {
  arguments: "Production service connection failed while validating the requested operations.",
  configuration: "Production service connection failed while reading or validating local production settings.",
  "worker-configuration": "Production service connection failed while validating the trusted Worker settings.",
  "checker-metadata": "Production service connection failed while reading the existing Worker's secret metadata.",
  "checker-upload": "Production service connection failed while uploading the checker signing key.",
  "telegram-database": "Production service connection failed while opening the Telegram database connection.",
  "telegram-webhook": "Production service connection failed while registering the Telegram webhook.",
  "telegram-cleanup": "Production service connection failed while closing the Telegram database connection.",
} as const;
type FailureStage = keyof typeof failureMessages;
const completedOperationLabels = {
  "checker-key-upload": "checker signing key upload",
  "telegram-webhook-registration": "Telegram webhook registration",
} as const;
type CompletedOperation = keyof typeof completedOperationLabels;

export class ServiceConnectionError extends Error {
  readonly stage: FailureStage;
  readonly completedOperations: readonly CompletedOperation[];

  constructor(stage: FailureStage, completedOperations: readonly CompletedOperation[]) {
    super("Service connection failed.");
    this.stage = stage;
    this.completedOperations = Object.freeze([...completedOperations]);
  }
}

/** Display only fixed labels. Provider exceptions and configuration never reach this boundary. */
export function serviceConnectionFailureMessage(error: unknown): string {
  const privacy = "No secret values or raw errors were displayed.";
  if (!(error instanceof ServiceConnectionError) || !Object.hasOwn(failureMessages, error.stage)) return `Production service connection failed. ${privacy}`;
  const completed = error.completedOperations
    .filter((operation) => Object.hasOwn(completedOperationLabels, operation))
    .map((operation) => completedOperationLabels[operation]);
  return `${failureMessages[error.stage]} Completed operations: ${completed.join(", ") || "none"}. ${privacy}`;
}

export function parseConnectArguments(args: readonly string[]): Operation {
  if (!args.length || new Set(args).size !== args.length ||
    args.some((arg) => !["--upload-checker-key", "--register-telegram"].includes(arg))) throw invalid();
  return { uploadCheckerKey: args.includes("--upload-checker-key"), registerTelegram: args.includes("--register-telegram") };
}

function validSigningKey(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value.trim() === value && !/[\r\n\0]/.test(value);
}

export function readServiceConnectionSettings(env: Environment, operation: Operation): ServiceSettings {
  try {
    const runtime = readRuntimePostgresUrl(env.DATABASE_URL);
    const origin = env.APP_URL;
    if (!origin || parseWebhookTarget(`${origin}/api/telegram/webhook`, "webhook").origin !== origin ||
      !validSigningKey(env.INTERNAL_HMAC_SECRET)) throw invalid();
    const telegram = [env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_BOT_USERNAME];
    if ((operation.registerTelegram || telegram.some((value) => value !== undefined)) &&
      (!isTelegramBotToken(env.TELEGRAM_BOT_TOKEN) || !isTelegramWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET) ||
        !/^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME ?? ""))) throw invalid();
    let adminUrl: string | undefined;
    if (operation.registerTelegram) {
      adminUrl = readPostgresUrl(env.MIGRATION_DATABASE_URL);
      const admin = new URL(adminUrl);
      const project = postgresProject(runtime);
      if (postgresProject(adminUrl) !== project || admin.pathname !== new URL(runtime).pathname ||
        !["", "5432"].includes(admin.port) ||
        decodeURIComponent(admin.username) !== (admin.hostname.endsWith(".pooler.supabase.com") ? `postgres.${project}` : "postgres")) throw invalid();
    }
    return { origin, signingKey: env.INTERNAL_HMAC_SECRET, botToken: env.TELEGRAM_BOT_TOKEN, webhookSecret: env.TELEGRAM_WEBHOOK_SECRET, adminUrl };
  } catch {
    throw invalid();
  }
}

/** Only fixed CLI arguments and the one requested signing key reach Wrangler. */
export function checkerKeyCommands(signingKey: string, ambient: Environment = process.env): WranglerInvocation[] {
  if (!validSigningKey(signingKey)) throw invalid();
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production", CI: "true", WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false",
    WRANGLER_LOG: "none", WRANGLER_LOG_SANITIZE: "true", CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
  };
  for (const name of ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM", "NO_COLOR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    if (ambient[name]) env[name] = ambient[name];
  }
  const common = ["--config", fileURLToPath(workerFile), "--name", workerName, "--env-file", process.platform === "win32" ? "NUL" : "/dev/null", "--install-skills=false"];
  const base = { executable: process.execPath, cwd: repository, env };
  const wrangler = fileURLToPath(new URL("../../../node_modules/wrangler/bin/wrangler.js", import.meta.url));
  return [
    // JSON secret metadata is emitted through Wrangler's normal logger. Keep it
    // readable for validation while disk logging and key-upload output stay off.
    { ...base, env: { ...env, WRANGLER_LOG: "log" }, args: [wrangler, "secret", "list", "--format", "json", ...common] },
    { ...base, args: [wrangler, "secret", "put", "INTERNAL_HMAC_SECRET", ...common], input: signingKey },
  ];
}

async function executeWrangler(command: WranglerInvocation): Promise<string> {
  const child = spawn(command.executable, command.args, {
    cwd: command.cwd, env: command.env, stdio: ["pipe", "pipe", "pipe"], timeout: 30_000,
  });
  let output = "";
  let oversized = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (command.input !== undefined) return;
    output += chunk.toString();
    if (Buffer.byteLength(output, "utf8") > 1_048_576) { oversized = true; child.kill(); }
  });
  child.stderr.resume();
  const completion = new Promise<void>((resolveCommand, reject) => {
    child.once("error", () => reject(new Error()));
    child.once("close", (code) => code === 0 && !oversized ? resolveCommand() : reject(new Error()));
    child.stdin.on("error", () => {});
  });
  child.stdin.end(command.input);
  await completion;
  return output;
}

function telegramDatabaseOptions(saved: Environment, ambient: Environment) {
  for (const environment of ambient === process.env ? [ambient] : [ambient, process.env]) {
    for (const key of ["DATABASE_CA_FILE", "DATABASE_CA_PEM"] as const) {
      if (environment[key] !== undefined && environment[key] !== saved[key]) throw invalid();
    }
  }
  const fallback = resolve(web, ".certs/supabase-ca.crt");
  const caFile = saved.DATABASE_CA_FILE !== undefined ? resolve(web, saved.DATABASE_CA_FILE) :
    saved.DATABASE_CA_PEM === undefined && existsSync(fallback) ? fallback : undefined;
  return postgresOptions(caFile, saved.DATABASE_CA_PEM);
}

/** A local administrative read capability, never a user-DAL ownership bypass. */
async function telegramRegistration(settings: ServiceSettings, _saved: Environment): Promise<Registration> {
  if (!settings.adminUrl || !settings.botToken || !settings.webhookSecret || !settings.databaseOptions) throw invalid();
  const client = postgres(settings.adminUrl, settings.databaseOptions);
  try {
    await client`SELECT 1`;
    const guard = createWebGuard({
      appUrl: settings.origin,
      async isBlockedHost(host, { signal }) {
        if (signal.aborted) return true;
        const rows = await client.begin("read only", async (transaction) => {
          await transaction`SET LOCAL statement_timeout = '5s'`;
          return transaction`SELECT host,include_subdomains AS "includeSubdomains" FROM blocked_hosts`;
        });
        return signal.aborted || isBlockedHost(host, Array.from(rows));
      },
    });
    const botToken = settings.botToken;
    const secret = settings.webhookSecret;
    return { register: () => guard.registerTelegramWebhook(botToken, secret), close: () => client.end({ timeout: 5 }) };
  } catch {
    await client.end({ timeout: 5 });
    throw new Error();
  }
}

/** Run by the owner locally after deployment. It never sends an alert message. */
export async function connectServices(args: readonly string[], dependencies: Partial<Dependencies> = {}): Promise<void> {
  let stage: FailureStage = "arguments";
  const completedOperations: CompletedOperation[] = [];
  try {
    const operation = parseConnectArguments(args);
    const ambient = dependencies.environment ?? process.env;
    stage = "configuration";
    const { content } = await (dependencies.readConfiguration ?? readPrivateConfiguration)(productionFile);
    const saved = parseEnv(content);
    for (const key of ["DATABASE_URL", "DATABASE_CA_FILE", "DATABASE_CA_PEM", "APP_URL", "INTERNAL_HMAC_SECRET", "MIGRATION_DATABASE_URL", "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME"]) {
      if ((content.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=`, "gm")) ?? []).length > 1) throw invalid();
    }
    const settings = readServiceConnectionSettings(saved, operation);
    if (operation.registerTelegram) settings.databaseOptions = telegramDatabaseOptions(saved, ambient);
    if (operation.uploadCheckerKey) {
      stage = "worker-configuration";
      const worker = JSON.parse(await (dependencies.readWorkerConfiguration ?? ((file: URL) => readFile(file, "utf8")))(workerFile));
      if (worker.name !== workerName || worker.workers_dev !== false || worker.preview_urls !== false || worker.vars?.APP_URL !== settings.origin) throw invalid();
    }
    if (operation.uploadCheckerKey) {
      const [list, put] = checkerKeyCommands(settings.signingKey, ambient);
      const execute = dependencies.execute ?? executeWrangler;
      stage = "checker-metadata";
      const existing: unknown = JSON.parse(await execute(list));
      if (!Array.isArray(existing) || existing.some((secret) => !secret || typeof secret.name !== "string" || secret.type !== "secret_text")) throw invalid();
      stage = "checker-upload";
      await execute(put);
      completedOperations.push("checker-key-upload");
    }
    if (operation.registerTelegram) {
      stage = "telegram-database";
      const registration = await (dependencies.registration ?? telegramRegistration)(settings, saved);
      try {
        stage = "telegram-webhook";
        await registration.register();
        completedOperations.push("telegram-webhook-registration");
      } catch {
        await registration.close().catch(() => {});
        throw new Error();
      }
      stage = "telegram-cleanup";
      await registration.close();
    }
  } catch {
    throw new ServiceConnectionError(stage, completedOperations);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await connectServices(process.argv.slice(2));
    console.log("Requested production service connections completed. No secret values were displayed.");
  } catch (error) {
    console.error(serviceConnectionFailureMessage(error));
    process.exitCode = 1;
  }
}
