import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { identity } from "../../../shared/identity.ts";
import { createChannelCipher } from "../alerts/channel-crypto.ts";
import { readAuthConfig } from "../auth/config.ts";
import { readRuntimePostgresUrl } from "../db/postgres-config.ts";
import { isMonitorId } from "../monitors/input.ts";

type Environment = Readonly<Record<string, string | undefined>>;
export type PublicProductionSettings = { origin: string; abuseContact: string; proofCapture?: boolean };
const providers = ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET", "AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET"] as const;
const runtimeNames = [
  "DATABASE_URL", "DATABASE_CA_PEM", "AUTH_SECRET", ...providers,
  "INTERNAL_HMAC_SECRET", "CHANNEL_ENC_KEY", "CHANNEL_ENC_KEY_ID",
  "CHANNEL_ENC_PREVIOUS_KEY", "CHANNEL_ENC_PREVIOUS_KEY_ID",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "TELEGRAM_BOT_USERNAME",
  "APP_URL", "ABUSE_CONTACT_EMAIL", "SIGNUP_MODE",
  "DOGFOOD_EXPORT_HMAC_SECRET", "DOGFOOD_EXPORT_MONITOR_IDS",
] as const;
const invalid = () => new Error("Production settings are invalid.");

/** Only OAuth application credentials may be explicitly reused from development. */
export function prepareProductionEnvironment(existing: Environment, settings: PublicProductionSettings, development?: Environment) {
  try {
    const saved: Record<string, string> = {};
    for (const [key, value] of Object.entries(existing)) if (value !== undefined) saved[key] = value;
    readRuntimePostgresUrl(saved.DATABASE_URL);
    if (saved.SIGNUP_MODE && saved.SIGNUP_MODE !== "invite") throw invalid();
    saved.APP_URL = settings.origin;
    saved.ABUSE_CONTACT_EMAIL = settings.abuseContact;
    saved.SIGNUP_MODE = "invite";
    saved.AUTH_SECRET ||= randomBytes(48).toString("base64url");
    saved.INTERNAL_HMAC_SECRET ||= randomBytes(48).toString("base64url");
    if (settings.proofCapture) {
      saved.DOGFOOD_EXPORT_HMAC_SECRET ||= randomBytes(48).toString("base64url");
      saved.DOGFOOD_PROOF_KEY ||= randomBytes(32).toString("base64url");
    }
    if (saved.DOGFOOD_EXPORT_HMAC_SECRET && (saved.DOGFOOD_EXPORT_HMAC_SECRET.length < 32 ||
      /[\r\n\0]/.test(saved.DOGFOOD_EXPORT_HMAC_SECRET) || saved.DOGFOOD_EXPORT_HMAC_SECRET === saved.INTERNAL_HMAC_SECRET)) throw invalid();
    if (saved.DOGFOOD_PROOF_KEY && (Buffer.from(saved.DOGFOOD_PROOF_KEY, "base64url").length !== 32 ||
      Buffer.from(saved.DOGFOOD_PROOF_KEY, "base64url").toString("base64url") !== saved.DOGFOOD_PROOF_KEY)) throw invalid();
    if (!saved.CHANNEL_ENC_KEY && !saved.CHANNEL_ENC_KEY_ID) {
      saved.CHANNEL_ENC_KEY = randomBytes(32).toString("base64url");
      saved.CHANNEL_ENC_KEY_ID = "production-v1";
    }
    if (saved.DOGFOOD_PROOF_KEY && saved.DOGFOOD_PROOF_KEY === saved.CHANNEL_ENC_KEY) throw invalid();
    if (saved.DOGFOOD_EXPORT_MONITOR_IDS) {
      const ids = saved.DOGFOOD_EXPORT_MONITOR_IDS.split(",");
      if (ids.length !== 2 || ids.some((id) => !isMonitorId(id)) || ids[0].toLowerCase() === ids[1].toLowerCase()) throw invalid();
      saved.DOGFOOD_EXPORT_MONITOR_IDS = ids.map((id) => id.toLowerCase()).join(",");
    }
    for (const key of providers) if (!saved[key] && development?.[key]) saved[key] = development[key];
    const auth = readAuthConfig(saved, true);
    if (!identity.abuseContactEmail(saved) || auth.signupMode !== "invite" ||
      saved.INTERNAL_HMAC_SECRET.length < 32 || /[\r\n\0]/.test(saved.INTERNAL_HMAC_SECRET)) throw invalid();
    saved.APP_URL = auth.baseURL;
    createChannelCipher(saved);
    if (saved.TELEGRAM_BOT_TOKEN && saved.TELEGRAM_BOT_USERNAME && !saved.TELEGRAM_WEBHOOK_SECRET) {
      saved.TELEGRAM_WEBHOOK_SECRET = randomBytes(32).toString("base64url");
    }
    const telegram = [saved.TELEGRAM_BOT_TOKEN, saved.TELEGRAM_WEBHOOK_SECRET, saved.TELEGRAM_BOT_USERNAME];
    if (telegram.some(Boolean) && (!telegram.every(Boolean) ||
      !/^\d+:[A-Za-z0-9_-]+$/.test(saved.TELEGRAM_BOT_TOKEN) ||
      !/^[A-Za-z0-9_-]{32,256}$/.test(saved.TELEGRAM_WEBHOOK_SECRET) ||
      !/^[A-Za-z0-9_]{5,32}$/.test(saved.TELEGRAM_BOT_USERNAME))) throw invalid();
    const runtime: Record<string, string> = {};
    for (const key of runtimeNames) if (saved[key]) runtime[key] = saved[key];
    serializePrivateEnvironment(saved);
    if (Buffer.byteLength(JSON.stringify(runtime), "utf8") > 60_000) throw invalid();
    return { saved, runtime };
  } catch {
    throw invalid();
  }
}

/** Verify Node's own dotenv round-trip before persisting an arbitrary value. */
export function serializePrivateEnvironment(values: Readonly<Record<string, string>>): string {
  try {
    return Object.entries(values).map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(key) || typeof value !== "string" || /[\r\0]/.test(value)) throw invalid();
      for (const delimiter of ["'", '"', "`"]) {
        if (value.includes(delimiter)) continue;
        const line = `${key}=${delimiter}${value}${delimiter}\n`;
        if (parseEnv(line)[key] === value) return line;
      }
      throw invalid();
    }).join("");
  } catch {
    throw invalid();
  }
}

/** Refuse stale production settings instead of silently retaining old secrets. */
export function assertNoStaleRuntimeKeys(existing: readonly string[], desired: Readonly<Record<string, string>>): void {
  if (!Array.isArray(existing) || existing.some((key) => typeof key !== "string" || !Object.hasOwn(desired, key))) throw invalid();
}
