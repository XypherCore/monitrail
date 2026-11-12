import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { parseWebhookTarget } from "../../../shared/ssrf/address.ts";
import { createDataAccess, type DataExecutor } from "../data/access.ts";
import {
	reserveRollingLimits,
	urlValidationRateKey,
} from "../data/rolling-rate.ts";
import { MONITOR_LIMITS } from "../monitors/limits.ts";
import { WebGuardError } from "../security/web-ssrf.ts";
import type { createChannelCipher } from "./channel-crypto.ts";
import {
	channelCreateInput,
	channelLabel,
	isChannelId,
	type ChannelCreateInput,
} from "./channel-input.ts";
import {
	AlertAccessError,
	alertRows,
	hashTelegramCode,
	hasChannelSpace,
	withAlertOwner,
} from "./channel-store.ts";
import type {
	AlertResult,
	AlertSender,
	ChannelType,
	WebhookChannelType,
} from "./contracts.ts";

type CipherFactory = () => ReturnType<typeof createChannelCipher>;
type Dependencies = {
	cipher: CipherFactory;
	validateWebhook(
		url: string,
		type: WebhookChannelType,
	): Promise<{ url: string; host: string }>;
	send: AlertSender;
	telegramUsername(): string | undefined;
};

async function requireOwner(db: DataExecutor, ownerId: string) {
	if (
		!(
			await alertRows(
				db,
				sql`SELECT 1 FROM users WHERE id=${ownerId} FOR KEY SHARE`,
			)
		).length
	)
		throw new AlertAccessError("unavailable");
}

async function rate(
	db: DataExecutor,
	limits: { key: string; limit: number }[],
	windowSeconds?: number,
) {
	const retry = await reserveRollingLimits(db, limits, windowSeconds);
	if (retry !== null) throw new AlertAccessError("rate_limit", retry);
}

/** Writes from validated user sessions. Private destination material stays server-side. */
export function createAlertChannelAccess(
	db: DataExecutor,
	userId: string,
	dependencies: Dependencies,
) {
	const owner = createDataAccess(db, userId);
	const ownerId = userId.toLowerCase();
	const transaction = <T>(run: (tx: DataExecutor) => Promise<T>) =>
		withAlertOwner(db, ownerId, run);

	return {
		async create(input: ChannelCreateInput): Promise<{ id: string }> {
			const fields = channelCreateInput(input);
			if (!fields) throw new AlertAccessError("invalid");
			try {
				parseWebhookTarget(fields.url, fields.type);
			} catch {
				throw new WebGuardError("blocked");
			}

			await transaction(async (tx) => {
				await requireOwner(tx, ownerId);
				if (!(await hasChannelSpace(tx, ownerId)))
					throw new AlertAccessError("channel_limit");
				await rate(
					tx,
					[
						{
							key: urlValidationRateKey(ownerId),
							limit: MONITOR_LIMITS.validations,
						},
					],
					MONITOR_LIMITS.validationWindowSeconds,
				);
			});
			const destination = await dependencies.validateWebhook(
				fields.url,
				fields.type,
			);
			const id = randomUUID();
			const configEnc = dependencies
				.cipher()
				.encrypt(
					{ url: destination.url },
					{ id, userId: ownerId, type: fields.type },
				);

			return transaction(async (tx) => {
				await requireOwner(tx, ownerId);
				if (!(await hasChannelSpace(tx, ownerId)))
					throw new AlertAccessError("channel_limit");
				await tx.execute(sql`
          INSERT INTO alert_channels(id,user_id,type,label,config_enc)
          VALUES (${id},${ownerId},${fields.type},${fields.label},${configEnc})
        `);
				return { id };
			});
		},

		async rename(id: string, input: string) {
			const label = channelLabel(input);
			if (!label) throw new AlertAccessError("invalid");
			return isChannelId(id) && owner.renameChannel(id, label);
		},

		async remove(id: string) {
			return isChannelId(id) && owner.deleteChannel(id);
		},

		async test(id: string): Promise<AlertResult | null> {
			if (!isChannelId(id)) return null;
			id = id.toLowerCase();
			const channel = await transaction(async (tx) => {
				const [row] = await alertRows<{
					type: ChannelType;
					config_enc: string;
					is_verified: boolean;
				}>(
					tx,
					sql`
          SELECT type,config_enc,is_verified FROM alert_channels WHERE id=${id} AND user_id=${ownerId} FOR KEY SHARE
        `,
				);
				if (!row || (row.type === "telegram" && !row.is_verified)) return null;
				await rate(tx, [
					{ key: `alert-test:user:${ownerId}`, limit: 5 },
					{ key: `alert-test:channel:${id}`, limit: 3 },
				]);
				return row;
			});
			if (!channel) return null;

			const result = await dependencies.send({
				id,
				userId: ownerId,
				type: channel.type,
				configEnc: channel.config_enc,
				payload: {
					version: 1,
					event: "alert.test",
					event_id: randomUUID(),
					sent_at: null,
				},
			});
			if (result.ok) {
				const updated = await alertRows(
					db,
					sql`
          UPDATE alert_channels SET is_verified=true
          WHERE id=${id} AND user_id=${ownerId} AND type=${channel.type} RETURNING id
        `,
				);
				if (!updated.length) return null;
			}
			return result;
		},

		async issueTelegram() {
			const username = dependencies.telegramUsername();
			if (!username || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))
				throw new AlertAccessError("telegram_unavailable");
			dependencies.cipher();
			const code = randomBytes(32).toString("base64url");
			return transaction(async (tx) => {
				await requireOwner(tx, ownerId);
				if (!(await hasChannelSpace(tx, ownerId)))
					throw new AlertAccessError("channel_limit");
				await rate(tx, [{ key: `telegram-link:${ownerId}`, limit: 5 }]);
				const [row] = await alertRows<{ expires_at: Date | string }>(
					tx,
					sql`
          INSERT INTO telegram_link_codes(code_hash,user_id,expires_at)
          VALUES (${hashTelegramCode(code)},${ownerId},clock_timestamp()+interval '10 minutes')
          RETURNING expires_at
        `,
				);
				const url = new URL(`https://t.me/${username}`);
				url.searchParams.set("start", code);
				return { url: url.href, expiresAt: new Date(row.expires_at) };
			});
		},
	};
}
