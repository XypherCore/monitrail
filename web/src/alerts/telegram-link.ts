import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";
import type { TelegramCapability } from "../services/capabilities.ts";
import {
	alertRows,
	hashTelegramCode,
	hasChannelSpace,
	withAlertOwner,
} from "./channel-store.ts";
import type { createChannelCipher } from "./channel-crypto.ts";
import { isTelegramCode } from "./channel-input.ts";
import { isTelegramChatId } from "./telegram-target.ts";

export function createTelegramLinker(
	db: DataExecutor,
	cipher: () => ReturnType<typeof createChannelCipher>,
): TelegramCapability {
	return {
		async handleTelegramWebhook({ code, chatId, chatType }) {
			if (
				chatType !== "private" ||
				!isTelegramCode(code) ||
				!isTelegramChatId(chatId)
			)
				return { linked: false };
			const hash = hashTelegramCode(code);
			const [candidate] = await alertRows<{ user_id: string }>(
				db,
				sql`
        SELECT user_id FROM telegram_link_codes
        WHERE code_hash=${hash} AND used_at IS NULL AND expires_at>clock_timestamp()
      `,
			);
			if (!candidate) return { linked: false };
			const userId = candidate.user_id;
			return withAlertOwner(db, userId, async (tx) => {
				const [link] = await alertRows(
					tx,
					sql`
          SELECT 1 FROM telegram_link_codes
          WHERE code_hash=${hash} AND user_id=${userId} AND used_at IS NULL AND expires_at>clock_timestamp()
          FOR UPDATE
        `,
				);
				if (!link || !(await hasChannelSpace(tx, userId)))
					return { linked: false };
				const id = randomUUID();
				const configEnc = cipher().encrypt(
					{ chatId },
					{ id, userId, type: "telegram" },
				);
				await tx.execute(sql`
          INSERT INTO alert_channels(id,user_id,type,label,config_enc,is_verified)
          VALUES (${id},${userId},'telegram','Telegram',${configEnc},true)
        `);
				await tx.execute(sql`
          UPDATE telegram_link_codes SET used_at=clock_timestamp() WHERE code_hash=${hash} AND user_id=${userId}
        `);
				return { linked: true };
			});
		},
	};
}
