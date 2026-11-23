import { chmod, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { identity } from "../../../shared/identity.ts";
import {
  checkerKeyCommands,
  checkServiceSettings,
  connectServices,
  parseConnectArguments,
  readServiceConnectionSettings,
  readOnlyPrivateConfiguration,
  runServiceConnectionCommand,
  serviceConnectionFailureMessage,
  ServiceConnectionError,
  type WranglerInvocation,
} from "../../scripts/deploy/connect-services.ts";
import { serializePrivateEnvironment } from "./production-environment.ts";

const origin = "https://app.example.test";
const runtime = "postgres://monitrail_app.fixture:fixture-runtime-password@aws-0-test.pooler.supabase.com:6543/postgres";
const admin = "postgres://postgres.fixture:fixture-admin-password@aws-0-test.pooler.supabase.com:5432/postgres";
const settings = {
  APP_URL: origin, DATABASE_URL: runtime, MIGRATION_DATABASE_URL: admin,
  INTERNAL_HMAC_SECRET: "fixture_signing_key_that_is_not_a_real_secret",
  TELEGRAM_BOT_TOKEN: "123456:fixture_Bot_Token_Is_Not_Real",
  TELEGRAM_BOT_USERNAME: "FixtureMonitorBot",
  TELEGRAM_WEBHOOK_SECRET: "fixture_webhook_secret_that_is_not_a_real_secret",
};
const settingNames = [
  "PRODUCTION_FILE", "DUPLICATE_SETTINGS", "DATABASE_URL", "APP_URL", "INTERNAL_HMAC_SECRET",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET", "MIGRATION_DATABASE_URL",
  "DATABASE_CA_SOURCE", "DATABASE_CA_AMBIENT", "WORKER_CONFIGURATION",
];

function fixtures(values: Record<string, string> = settings) {
  const register = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const readConfiguration = vi.fn(async () => ({ content: serializePrivateEnvironment(values) }));
  const readWorkerConfiguration = vi.fn(async () => JSON.stringify({
    name: `${identity.brandName.toLowerCase()}-checker`, workers_dev: false, preview_urls: false,
    vars: { APP_URL: origin },
  }));
  const execute = vi.fn(async (command: WranglerInvocation): Promise<string> => command.args.includes("list") ? "[]" : "");
  const registration = vi.fn(async () => ({ register, close }));
  return { dependencies: { readConfiguration, readWorkerConfiguration, execute, registration, environment: {} as Record<string, string | undefined> }, register, close };
}

describe("owner-only production service connections", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_CA_FILE", undefined);
    vi.stubEnv("DATABASE_CA_PEM", undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires at least one exact explicit operation and refuses extra input", () => {
    expect(parseConnectArguments(["--upload-checker-key"])).toEqual({ uploadCheckerKey: true, registerTelegram: false });
    expect(parseConnectArguments(["--register-telegram", "--upload-checker-key"])).toEqual({ uploadCheckerKey: true, registerTelegram: true });
    for (const args of [[], ["--upload-checker-key", "--upload-checker-key"], ["--url", origin], ["--upload-checker-key", "private-fixture-secret"], ["--unknown"]]) {
      expect(() => parseConnectArguments(args)).toThrow("Service connection settings are invalid.");
    }
  });

  it("rejects unsafe runtime, origin, signing and partial Telegram configuration", () => {
    const operation = { uploadCheckerKey: true, registerTelegram: true };
    for (const changed of [
      { DATABASE_URL: runtime.replace("monitrail_app.", "postgres.") },
      { APP_URL: "http://app.example.test" }, { APP_URL: "https://127.0.0.1" },
      { APP_URL: "https://app.example.test/path" }, { APP_URL: "https://app.example.test?credential=fixture" },
      { INTERNAL_HMAC_SECRET: "short" }, { INTERNAL_HMAC_SECRET: `${settings.INTERNAL_HMAC_SECRET}\n` },
      { TELEGRAM_BOT_TOKEN: `${settings.TELEGRAM_BOT_TOKEN}/getMe` },
      { TELEGRAM_BOT_USERNAME: "bad username" }, { TELEGRAM_WEBHOOK_SECRET: "" },
      { MIGRATION_DATABASE_URL: admin.replace("postgres.fixture:", "postgres.other:") },
      { MIGRATION_DATABASE_URL: admin.replace(":5432", ":6543") },
    ]) expect(() => readServiceConnectionSettings({ ...settings, ...changed }, operation)).toThrow("Service connection settings are invalid.");
    expect(readServiceConnectionSettings(settings, operation)).toMatchObject({ origin });
  });

  it("passes only the checker key on stdin and strips unrelated secrets and unsafe ambient overrides", () => {
    const commands = checkerKeyCommands(settings.INTERNAL_HMAC_SECRET, {
      PATH: "/fixture/bin", HOME: "/fixture/home", CLOUDFLARE_API_TOKEN: "fixture-cloudflare-authentication",
      DATABASE_URL: runtime, TELEGRAM_BOT_TOKEN: settings.TELEGRAM_BOT_TOKEN,
      INTERNAL_HMAC_SECRET: settings.INTERNAL_HMAC_SECRET,
      NODE_OPTIONS: "--require private-fixture", CLOUDFLARE_API_BASE_URL: "https://attacker.example.test",
    });
    expect(commands).toHaveLength(2);
    expect(commands[0].args).toContain("list");
    expect(commands[0].input).toBeUndefined();
    expect(commands[1].args).toContain("put");
    expect(commands[1].input).toBe(settings.INTERNAL_HMAC_SECRET);
    for (const command of commands) {
      expect(command.args.join(" ")).not.toContain(settings.INTERNAL_HMAC_SECRET);
      expect(command.args).toContain(`${identity.brandName.toLowerCase()}-checker`);
      expect(command.env).toMatchObject({ WRANGLER_SEND_METRICS: "false", WRANGLER_WRITE_LOGS: "false", WRANGLER_LOG_SANITIZE: "true" });
      expect(command.env.DATABASE_URL).toBeUndefined();
      expect(command.env.TELEGRAM_BOT_TOKEN).toBeUndefined();
      expect(command.env.INTERNAL_HMAC_SECRET).toBeUndefined();
      expect(command.env.NODE_OPTIONS).toBeUndefined();
      expect(command.env.CLOUDFLARE_API_BASE_URL).toBeUndefined();
      expect(command.args).toContain("--env-file");
    }
  });

  it("uploads the verified checker key before opening Telegram's database or registering its webhook", async () => {
    const f = fixtures();
    const order: string[] = [];
    f.dependencies.execute.mockImplementation(async (command) => {
      order.push(command.args.includes("list") ? "metadata" : "upload");
      return command.args.includes("list") ? "[]" : "";
    });
    f.dependencies.registration.mockImplementation(async () => {
      order.push("telegram-database");
      return { register: f.register, close: f.close };
    });
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies);
      expect(order).toEqual(["metadata", "upload", "telegram-database"]);
      expect(f.dependencies.execute).toHaveBeenCalledTimes(2);
      expect(f.dependencies.registration).toHaveBeenCalledOnce();
      expect(f.register).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
      expect(logger).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });

  it("keeps machine-readable metadata output enabled while suppressing the key upload output", async () => {
    const f = fixtures();
    // Wrangler's JSON secret list uses logger.log, which emits nothing at "none".
    // Model that actual CLI boundary so an exit-zero empty result cannot pass.
    f.dependencies.execute.mockImplementation(async (command) => {
      if (!command.args.includes("list")) return "";
      return command.env.WRANGLER_LOG === "log" ? "[]" : "";
    });
    await expect(connectServices(["--upload-checker-key"], f.dependencies)).resolves.toBeUndefined();
    const [list, put] = f.dependencies.execute.mock.calls.map(([command]) => command);
    expect(list.env).toMatchObject({ WRANGLER_LOG: "log", WRANGLER_WRITE_LOGS: "false" });
    expect(put.env).toMatchObject({ WRANGLER_LOG: "none", WRANGLER_WRITE_LOGS: "false" });
    expect(list.env).not.toBe(put.env);
    expect(list.input).toBeUndefined();
    expect(put.input).toBe(settings.INTERNAL_HMAC_SECRET);
    expect(put.args).not.toContain(settings.INTERNAL_HMAC_SECRET);
  });

  it("refuses a missing checker and never uploads its key", async () => {
    const f = fixtures();
    f.dependencies.execute.mockRejectedValueOnce(new Error("private-auth-detail"));
    await expect(connectServices(["--upload-checker-key"], f.dependencies)).rejects.toThrow("Service connection failed.");
    expect(f.dependencies.execute).toHaveBeenCalledOnce();
    expect(f.register).not.toHaveBeenCalled();
  });

  it("refuses malformed Worker metadata before key upload or any Telegram database connection", async () => {
    for (const output of ["", "not-json", "{}", '[{"name":"OTHER","type":"plain_text"}]']) {
      const f = fixtures();
      f.dependencies.execute.mockResolvedValueOnce(output);
      await expect(connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies)).rejects.toThrow("Service connection failed.");
      expect(f.dependencies.execute).toHaveBeenCalledOnce();
      expect(f.register).not.toHaveBeenCalled();
      expect(f.dependencies.registration).not.toHaveBeenCalled();
      expect(f.close).not.toHaveBeenCalled();
    }
  });

  it.each(["DATABASE_CA_FILE", "DATABASE_CA_PEM"] as const)("rejects a conflicting ambient %s before requested external mutations", async (key) => {
    const f = fixtures();
    f.dependencies.environment[key] = "private-staging-ca-must-not-be-used";
    const error = await connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies).catch((failure) => failure);
    expect(error).toMatchObject({ message: "Service connection failed.", stage: "configuration", completedOperations: [] });
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
    expect(serviceConnectionFailureMessage(error)).not.toContain("private-staging");
  });

  it("accepts matching saved and ambient CA settings while preserving strict TLS", async () => {
    const ca = getCACertificates()[0];
    const f = fixtures({ ...settings, DATABASE_CA_PEM: ca });
    f.dependencies.environment.DATABASE_CA_PEM = ca;
    await connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies);
    expect(f.dependencies.registration).toHaveBeenCalledWith(expect.objectContaining({ databaseOptions: expect.objectContaining({ ssl: expect.objectContaining({ rejectUnauthorized: true }) }) }), expect.objectContaining({ DATABASE_CA_PEM: ca }));
  });

  it("rejects an invalid saved TLS source before uploading the checker key", async () => {
    const f = fixtures({ ...settings, DATABASE_CA_PEM: "private-invalid-certificate-fixture" });
    const error = await connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies).catch((failure) => failure);
    expect(error).toMatchObject({ stage: "configuration", completedOperations: [] });
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
    expect(serviceConnectionFailureMessage(error)).not.toContain("private-invalid");
  });

  it("does not consult Telegram database or CA settings for a checker-only operation", async () => {
    const f = fixtures();
    f.dependencies.environment.DATABASE_CA_FILE = "unrelated-local-fixture.crt";
    await connectServices(["--upload-checker-key"], f.dependencies);
    expect(f.dependencies.execute).toHaveBeenCalledTimes(2);
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it.each([
    ["arguments", [], []],
    ["configuration", ["--upload-checker-key", "--register-telegram"], []],
    ["worker-configuration", ["--upload-checker-key", "--register-telegram"], []],
    ["checker-metadata", ["--upload-checker-key", "--register-telegram"], []],
    ["checker-upload", ["--upload-checker-key", "--register-telegram"], []],
    ["telegram-database", ["--upload-checker-key", "--register-telegram"], ["checker-key-upload"]],
    ["telegram-webhook", ["--upload-checker-key", "--register-telegram"], ["checker-key-upload"]],
    ["telegram-cleanup", ["--upload-checker-key", "--register-telegram"], ["checker-key-upload", "telegram-webhook-registration"]],
  ] as const)("reports only an allowlisted stage and completed operations after %s failure", async (stage, args, completedOperations) => {
    const f = fixtures();
    const privateError = new Error("private-provider-token-and-url-detail");
    if (stage === "configuration") f.dependencies.readConfiguration.mockRejectedValueOnce(privateError);
    if (stage === "worker-configuration") f.dependencies.readWorkerConfiguration.mockRejectedValueOnce(privateError);
    if (stage === "checker-metadata") f.dependencies.execute.mockRejectedValueOnce(privateError);
    if (stage === "checker-upload") f.dependencies.execute.mockResolvedValueOnce("[]").mockRejectedValueOnce(privateError);
    if (stage === "telegram-database") f.dependencies.registration.mockRejectedValueOnce(privateError);
    if (stage === "telegram-webhook") f.register.mockRejectedValueOnce(privateError);
    if (stage === "telegram-cleanup") f.close.mockRejectedValueOnce(privateError);
    const error = await connectServices(args, f.dependencies).catch((failure) => failure);
    expect(error).toBeInstanceOf(ServiceConnectionError);
    expect(error).toMatchObject({ message: "Service connection failed.", stage, completedOperations });
    expect(error.cause).toBeUndefined();
    const display = serviceConnectionFailureMessage(error);
    expect(display).not.toContain("private-provider");
    expect(display).not.toContain("https:");
    expect(JSON.stringify(error)).not.toContain("private-provider");
    if (completedOperations.some((operation) => operation === "checker-key-upload")) expect(display).toContain("checker signing key upload");
    if (stage === "telegram-webhook" || stage === "telegram-cleanup") expect(f.close).toHaveBeenCalledOnce();
    if (["checker-metadata", "checker-upload"].includes(stage)) expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it("uses fixed public messages for unknown errors and never stringifies their private content", () => {
    const error = { message: "private-provider-detail", toString: vi.fn(() => "private-provider-detail") };
    const display = serviceConnectionFailureMessage(error);
    expect(display).toContain("Production service connection failed.");
    expect(display).not.toContain("private-provider-detail");
    expect(error.toString).not.toHaveBeenCalled();
  });

  it("refuses mismatched trusted Worker settings and duplicate private entries before external mutations", async () => {
    for (const worker of [
      { name: "another-worker", workers_dev: false, preview_urls: false, vars: { APP_URL: origin } },
      { name: `${identity.brandName.toLowerCase()}-checker`, workers_dev: true, preview_urls: false, vars: { APP_URL: origin } },
      { name: `${identity.brandName.toLowerCase()}-checker`, workers_dev: false, preview_urls: false, vars: { APP_URL: "https://another.example.test" } },
    ]) {
      const f = fixtures();
      f.dependencies.readWorkerConfiguration.mockResolvedValueOnce(JSON.stringify(worker));
      await expect(connectServices(["--upload-checker-key"], f.dependencies)).rejects.toThrow();
      expect(f.dependencies.execute).not.toHaveBeenCalled();
    }
    const f = fixtures();
    f.dependencies.readConfiguration.mockResolvedValueOnce({ content: `${serializePrivateEnvironment(settings)}  export APP_URL = 'https://other.example.test'\n` });
    await expect(connectServices(["--register-telegram"], f.dependencies)).rejects.toThrow();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it("performs only selected actions and releases the local database on provider failure", async () => {
    const telegram = fixtures();
    telegram.register.mockRejectedValueOnce(new Error("private-token-provider-response"));
    await expect(connectServices(["--register-telegram"], telegram.dependencies)).rejects.toThrow("Service connection failed.");
    expect(telegram.dependencies.execute).not.toHaveBeenCalled();
    expect(telegram.dependencies.readWorkerConfiguration).not.toHaveBeenCalled();
    expect(telegram.close).toHaveBeenCalledOnce();
    const checker = fixtures();
    await connectServices(["--upload-checker-key"], checker.dependencies);
    expect(checker.dependencies.registration).not.toHaveBeenCalled();
  });

  it("audits every saved setting through canonical local reads without contacting any service", async () => {
    const f = fixtures();
    const checks = await checkServiceSettings(f.dependencies);
    expect(checks).toEqual(settingNames.map((setting) => ({ setting, ok: true })));
    expect(f.dependencies.readConfiguration).toHaveBeenCalledExactlyOnceWith(new URL("../../.env.production.local", import.meta.url));
    expect(f.dependencies.readWorkerConfiguration).toHaveBeenCalledExactlyOnceWith(new URL("../../../checker/wrangler.jsonc", import.meta.url));
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
    expect(f.register).not.toHaveBeenCalled();
    expect(f.close).not.toHaveBeenCalled();
  });

  it.each([
    ["DATABASE_URL", { DATABASE_URL: runtime.replace("monitrail_app.", "postgres.") }],
    ["APP_URL", { APP_URL: "http://private-invalid-origin.example.test" }],
    ["INTERNAL_HMAC_SECRET", { INTERNAL_HMAC_SECRET: "private-short" }],
    ["TELEGRAM_BOT_TOKEN", { TELEGRAM_BOT_TOKEN: "private-invalid-token" }],
    ["TELEGRAM_BOT_USERNAME", { TELEGRAM_BOT_USERNAME: "private invalid username" }],
    ["TELEGRAM_WEBHOOK_SECRET", { TELEGRAM_WEBHOOK_SECRET: "private invalid secret" }],
    ["MIGRATION_DATABASE_URL", { MIGRATION_DATABASE_URL: admin.replace("postgres.fixture:", "postgres.other:") }],
    ["MIGRATION_DATABASE_URL", { MIGRATION_DATABASE_URL: admin.replace(":5432", ":6543") }],
    ["MIGRATION_DATABASE_URL", { MIGRATION_DATABASE_URL: admin.replace("/postgres", "/other-database") }],
    ["DATABASE_CA_SOURCE", { DATABASE_CA_PEM: "private-invalid-ca" }],
  ])("flags invalid %s with the same production validators and never connects", async (setting, changed) => {
    const f = fixtures({ ...settings, ...changed });
    const checks = await checkServiceSettings(f.dependencies);
    expect(checks).toContainEqual({ setting, ok: false });
    expect(checks.map((check) => check.setting)).toEqual(settingNames);
    expect(JSON.stringify(checks)).not.toContain("private-");
    await expect(connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies)).rejects.toThrow("Service connection failed.");
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it("flags duplicate saved settings without echoing their names or values from the input", async () => {
    const f = fixtures();
    f.dependencies.readConfiguration.mockResolvedValue({ content: `${serializePrivateEnvironment(settings)}export APP_URL = 'https://private-duplicate.example.test'\n` });
    const checks = await checkServiceSettings(f.dependencies);
    expect(checks).toContainEqual({ setting: "DUPLICATE_SETTINGS", ok: false });
    expect(JSON.stringify(checks)).not.toContain("private-duplicate");
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it.each(["DATABASE_CA_FILE", "DATABASE_CA_PEM"] as const)("reports ambient %s conflicts without replacing the saved CA source", async (key) => {
    const f = fixtures({ ...settings, DATABASE_CA_PEM: getCACertificates()[0] });
    f.dependencies.environment[key] = "private-conflicting-ca-value";
    const checks = await checkServiceSettings(f.dependencies);
    expect(checks).toContainEqual({ setting: "DATABASE_CA_AMBIENT", ok: false });
    expect(checks).toContainEqual({ setting: "DATABASE_CA_SOURCE", ok: true });
    expect(JSON.stringify(checks)).not.toContain("private-conflicting");
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it("flags two saved CA sources without reading an arbitrary configured certificate path", async () => {
    const f = fixtures({ ...settings, DATABASE_CA_FILE: "private-path-must-not-be-read", DATABASE_CA_PEM: getCACertificates()[0] });
    expect(await checkServiceSettings(f.dependencies)).toContainEqual({ setting: "DATABASE_CA_SOURCE", ok: false });
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it.each(["private-worker-json", JSON.stringify({ name: "private-other-worker" })])("fails malformed or mismatched trusted Worker configuration without any provider calls", async (content) => {
    const f = fixtures();
    f.dependencies.readWorkerConfiguration.mockResolvedValue(content);
    const checks = await checkServiceSettings(f.dependencies);
    expect(checks).toContainEqual({ setting: "WORKER_CONFIGURATION", ok: false });
    expect(JSON.stringify(checks)).not.toContain("private-");
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it("sanitizes unreadable private files and raw local errors into the fixed failed checklist", async () => {
    const f = fixtures();
    f.dependencies.readConfiguration.mockRejectedValue(new Error("private-file-path-token-detail"));
    const checks = await checkServiceSettings(f.dependencies);
    expect(checks).toEqual(settingNames.map((setting) => ({ setting, ok: false })));
    expect(JSON.stringify(checks)).not.toContain("private-file");
    expect(f.dependencies.readWorkerConfiguration).not.toHaveBeenCalled();
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it.each([true, false])("prints only fixed setting names and PASS/FAIL in exact read-only CLI mode (valid=%s)", async (valid) => {
    const f = fixtures(valid ? settings : { ...settings, TELEGRAM_BOT_TOKEN: "private-invalid-token" });
    const output = vi.fn((_line: string) => {});
    expect(await runServiceConnectionCommand(["--check-settings"], f.dependencies, output)).toBe(valid);
    const lines = output.mock.calls.map(([line]) => line);
    expect(lines).toHaveLength(settingNames.length);
    expect(lines.every((line) => /^[A-Z_]+: (PASS|FAIL)$/.test(line))).toBe(true);
    expect(lines.map((line) => line.split(":")[0])).toEqual(settingNames);
    expect(lines.join("\n")).not.toContain("private-");
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it.each([
    { args: ["--check-settings", "--upload-checker-key"] },
    { args: ["--check-settings", "--register-telegram"] },
    { args: ["--check-settings", "--check-settings"] },
  ])("rejects audit mode combined with other arguments before reading settings or connecting", async ({ args }) => {
    const f = fixtures();
    await expect(runServiceConnectionCommand(args, f.dependencies, vi.fn())).rejects.toMatchObject({ stage: "arguments", completedOperations: [] });
    expect(f.dependencies.readConfiguration).not.toHaveBeenCalled();
    expect(f.dependencies.execute).not.toHaveBeenCalled();
    expect(f.dependencies.registration).not.toHaveBeenCalled();
  });

  it("reads only an owned regular private configuration file without chmod or following symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-settings-audit-"));
    const file = join(directory, "fixture.local");
    const linked = join(directory, "linked.local");
    try {
      await writeFile(file, "private-synthetic-content", { mode: 0o400 });
      expect(await readOnlyPrivateConfiguration(pathToFileURL(file))).toEqual({ content: "private-synthetic-content" });
      expect((await stat(file)).mode & 0o777).toBe(0o400);
      await symlink(file, linked);
      await expect(readOnlyPrivateConfiguration(pathToFileURL(linked))).rejects.toThrow();
      await chmod(file, 0o644);
      await expect(readOnlyPrivateConfiguration(pathToFileURL(file))).rejects.toThrow();
      expect((await stat(file)).mode & 0o777).toBe(0o644);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
