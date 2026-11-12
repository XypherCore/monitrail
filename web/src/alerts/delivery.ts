import { identity as brand } from "../../../shared/identity.ts";
import { isMonitorId } from "../monitors/input.ts";
import { type createWebGuard, WebGuardError } from "../security/web-ssrf.ts";
import type { createChannelCipher } from "./channel-crypto.ts";
import type { AlertErrorCategory, AlertSender } from "./contracts.ts";

type Dependencies = {
  cipher: Pick<ReturnType<typeof createChannelCipher>, "decrypt">;
  guard: Pick<ReturnType<typeof createWebGuard>, "sendWebhook" | "sendTelegram">;
  botToken?: string;
  now?: () => Date;
};
const causes: ReadonlySet<unknown> = new Set<AlertErrorCategory>([
  "blocked", "dns", "timeout", "connect", "tls", "bad_status", "other",
]);

function invalidAlert(): never {
  throw new Error("Alert payload is invalid.");
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidAlert();
  return value as Record<string, unknown>;
}

function isoDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) invalidAlert();
  return new Date(value).toISOString();
}

function project(value: unknown, now: Date) {
  const { version, event, event_id, monitor, incident } = record(value);
  if (version !== 1 || !isMonitorId(event_id)) invalidAlert();
  const common = { version: 1 as const, event_id, sent_at: now.toISOString() };
  if (event === "alert.test") return { ...common, event } as const;
  if (event !== "incident.opened" && event !== "incident.resolved") invalidAlert();
  const { name } = record(monitor);
  const { started_at, confirmed_at, resolved_at, cause } = record(incident);
  if (typeof name !== "string" || !name.trim() || !causes.has(cause)) invalidAlert();
  if (event === "incident.opened" && resolved_at !== null) invalidAlert();
  return {
    ...common,
    event,
    monitor: { name },
    incident: {
      started_at: isoDate(started_at),
      confirmed_at: isoDate(confirmed_at),
      resolved_at: event === "incident.resolved" ? isoDate(resolved_at) : null,
      cause: cause as AlertErrorCategory,
    },
  } as const;
}

function message(payload: ReturnType<typeof project>) {
  if (payload.event === "alert.test") return `${brand.brandName} test alert.`;
  const name = payload.monitor.name.replace(/[\p{Cc}\p{Cf}]+/gu, " ").trim().slice(0, 512);
  const state = payload.event === "incident.opened" ? "is down" : "has recovered";
  return `${name} ${state}. Event ${payload.event_id}`;
}

export function createAlertSender({ cipher, guard, botToken, now = () => new Date() }: Dependencies): AlertSender {
  return async ({ configEnc, payload, ...channel }) => {
    try {
      const safe = project(payload, now());
      const destination = cipher.decrypt(configEnc, channel);
      if (channel.type === "telegram") {
        if (!botToken || !("chatId" in destination)) invalidAlert();
        await guard.sendTelegram(botToken, destination.chatId, message(safe));
      } else {
        if (!("url" in destination)) invalidAlert();
        const body = channel.type === "discord"
          ? {
              content: message(safe).replace(/[\\`*_{}[\]()<>#|~]/gu, "\\$&"),
              allowed_mentions: { parse: [] },
              flags: 4, // Suppress link embeds.
            }
          : channel.type === "slack"
            ? {
                text: message(safe).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
                mrkdwn: false,
                unfurl_links: false,
                unfurl_media: false,
              }
            : safe;
        await guard.sendWebhook(destination.url, channel.type, body);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, category: error instanceof WebGuardError ? error.code : "other" };
    }
  };
}
