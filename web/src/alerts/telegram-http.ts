import { createHash, timingSafeEqual } from "node:crypto";
import type { TelegramCapability } from "../services/capabilities.ts";
import {
	isTelegramCode,
	isTelegramWebhookSecret,
	object,
} from "./channel-input.ts";
import {
	alertPrivateHeaders,
	AlertRequestError,
	readAlertJson,
} from "./request-json.ts";
import { isTelegramChatId } from "./telegram-target.ts";

type Dependencies = {
	secret(): unknown;
	link: TelegramCapability["handleTelegramWebhook"];
};

function sameSecret(left: string, right: string) {
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(left), digest(right));
}

function privateStart(
	value: unknown,
): Parameters<Dependencies["link"]>[0] | null {
	const update = object(value);
	if (
		!update ||
		!Number.isSafeInteger(update.update_id) ||
		Number(update.update_id) < 0
	)
		return null;
	const message = object(update.message);
	const chat = object(message?.chat);
	const sender = object(message?.from);
	if (
		!message ||
		typeof message.text !== "string" ||
		message.forward_origin !== undefined ||
		message.is_automatic_forward === true ||
		message.sender_chat !== undefined ||
		chat?.type !== "private" ||
		typeof chat.id !== "number" ||
		!isTelegramChatId(String(chat.id)) ||
		sender?.is_bot !== false ||
		sender.id !== chat.id
	)
		return null;
	const command = /^\/start ([A-Za-z0-9_-]{43})$/.exec(message.text);
	if (!command || !isTelegramCode(command[1])) return null;
	return { chatId: String(chat.id), code: command[1], chatType: "private" };
}

export function createTelegramWebhookHandler(deps: Dependencies) {
	const respond = (status: number) =>
		new Response(null, { status, headers: alertPrivateHeaders });
	return async (request: Request): Promise<Response> => {
		if (request.method !== "POST") {
			const response = respond(405);
			response.headers.set("allow", "POST");
			return response;
		}
		try {
			const url = new URL(request.url);
			if (url.pathname !== "/api/telegram/webhook" || url.search || url.hash)
				return respond(404);
			const provided = request.headers.get("x-telegram-bot-api-secret-token");
			const secret = deps.secret();
			if (
				!isTelegramWebhookSecret(secret) ||
				!isTelegramWebhookSecret(provided) ||
				!sameSecret(provided, secret)
			)
				return respond(404);
			const command = privateStart(await readAlertJson(request));
			if (command) await deps.link(command);
			return respond(200);
		} catch (error) {
			return respond(error instanceof AlertRequestError ? error.status : 503);
		}
	};
}
