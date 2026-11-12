import "server-only";
import { sql } from "drizzle-orm";
import { isBlockedHost } from "../../../shared/ssrf/blocklist.ts";
import type { DataExecutor } from "../data/access.ts";
import { createWebGuard } from "../security/web-ssrf.ts";
import { createChannelCipher } from "./channel-crypto.ts";
import type { AlertSender } from "./contracts.ts";
import { createAlertSender } from "./delivery.ts";

export function createRuntimeAlertGuard(db: DataExecutor, appUrl: string) {
  return createWebGuard({
    appUrl,
    async isBlockedHost(host, { signal }) {
      if (signal.aborted) return true;
      const { rows } = await db.execute(sql`
        SELECT host,include_subdomains AS "includeSubdomains" FROM blocked_hosts
      `);
      return signal.aborted || isBlockedHost(host, rows);
    },
  });
}

export function createRuntimeAlertSender(db: DataExecutor): AlertSender {
  return async (input) => {
    try {
      return await createAlertSender({
        cipher: createChannelCipher(),
        guard: createRuntimeAlertGuard(db, process.env.APP_URL ?? ""),
        botToken: process.env.TELEGRAM_BOT_TOKEN,
      })(input);
    } catch {
      return { ok: false, category: "other" };
    }
  };
}
