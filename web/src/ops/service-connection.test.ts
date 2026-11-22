import { describe, expect, it, vi } from "vitest";
import { identity } from "../../../shared/identity.ts";
import {
  checkerKeyCommands,
  connectServices,
  parseConnectArguments,
  readServiceConnectionSettings,
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
  return { dependencies: { readConfiguration, readWorkerConfiguration, execute, registration }, register, close };
}

describe("owner-only production service connections", () => {
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

  it("verifies the existing checker before uploading and then registers Telegram", async () => {
    const f = fixtures();
    const logger = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies);
      expect(f.dependencies.execute).toHaveBeenCalledTimes(2);
      expect(f.dependencies.registration).toHaveBeenCalledOnce();
      expect(f.register).toHaveBeenCalledOnce();
      expect(f.close).toHaveBeenCalledOnce();
      expect(logger).not.toHaveBeenCalled();
    } finally { logger.mockRestore(); }
  });

  it("refuses a missing checker and never uploads its key", async () => {
    const f = fixtures();
    f.dependencies.execute.mockRejectedValueOnce(new Error("private-auth-detail"));
    await expect(connectServices(["--upload-checker-key"], f.dependencies)).rejects.toThrow("Service connection failed.");
    expect(f.dependencies.execute).toHaveBeenCalledOnce();
    expect(f.register).not.toHaveBeenCalled();
  });

  it("refuses malformed Worker metadata before key upload and closes the registration connection", async () => {
    for (const output of ["not-json", "{}", '[{"name":"OTHER","type":"plain_text"}]']) {
      const f = fixtures();
      f.dependencies.execute.mockResolvedValueOnce(output);
      await expect(connectServices(["--upload-checker-key", "--register-telegram"], f.dependencies)).rejects.toThrow("Service connection failed.");
      expect(f.dependencies.execute).toHaveBeenCalledOnce();
      expect(f.register).not.toHaveBeenCalled();
      expect(f.close).toHaveBeenCalledOnce();
    }
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
});
