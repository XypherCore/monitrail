import "server-only";
import { readAuthConfig } from "../auth/config.ts";
import { getAuthRuntime } from "../auth/runtime.ts";
import { getRuntimeDatabase } from "../db/runtime.ts";
import { createAlertChannelAccess } from "./channel-access.ts";
import { createChannelCipher } from "./channel-crypto.ts";
import { isChannelId, isTelegramWebhookSecret } from "./channel-input.ts";
import {
	createRuntimeAlertGuard,
	createRuntimeAlertSender,
} from "./delivery-runtime.ts";
import { createAlertHandlers } from "./http.ts";
import { createTelegramWebhookHandler } from "./telegram-http.ts";
import { createTelegramLinker } from "./telegram-link.ts";
import { isTelegramBotToken } from "./telegram-target.ts";

const cipher = () => createChannelCipher();

export const alertChannelHandlers = createAlertHandlers({
	origin: () =>
		readAuthConfig(process.env, process.env.NODE_ENV === "production").baseURL,
	async authenticate(request, appUrl) {
		if (!request.headers.has("cookie")) return null;
		const session = await getAuthRuntime().api.getSession({
			headers: request.headers,
			query: { disableRefresh: true },
		});
		if (!session || !isChannelId(session.user.id)) return null;
		const db = getRuntimeDatabase();
		const guard = createRuntimeAlertGuard(db, appUrl);
		return createAlertChannelAccess(db, session.user.id, {
			cipher,
			validateWebhook: guard.validateWebhook,
			send: createRuntimeAlertSender(db),
			telegramUsername: () =>
				isTelegramWebhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET) &&
				isTelegramBotToken(process.env.TELEGRAM_BOT_TOKEN)
					? process.env.TELEGRAM_BOT_USERNAME
					: undefined,
		});
	},
});

export const telegramWebhookHandler = createTelegramWebhookHandler({
	secret: () => process.env.TELEGRAM_WEBHOOK_SECRET,
	link: (input) =>
		createTelegramLinker(getRuntimeDatabase(), cipher).handleTelegramWebhook(
			input,
		),
});
