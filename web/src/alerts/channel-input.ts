import { isMonitorId } from "../monitors/input.ts";
import type { WebhookChannelType } from "./contracts.ts";

export type ChannelCreateInput = {
	type: WebhookChannelType;
	label: string;
	url: string;
};

export function object(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function channelLabel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const label = value.trim();
	return label.length && label.length <= 80 && !/\p{Cc}/u.test(label)
		? label
		: null;
}

export function channelCreateInput(value: unknown): ChannelCreateInput | null {
	const input = object(value);
	if (!input || Object.keys(input).length !== 3) return null;
	const { type, url } = input;
	const label = channelLabel(input.label);
	if (
		!label ||
		(type !== "webhook" && type !== "slack" && type !== "discord") ||
		typeof url !== "string" ||
		url.length === 0 ||
		url.length > 4096
	)
		return null;
	return { type, label, url };
}

export function channelRenameInput(value: unknown): string | null {
	const input = object(value);
	return input && Object.keys(input).length === 1
		? channelLabel(input.label)
		: null;
}

export const isChannelId = isMonitorId;
export const isTelegramCode = (value: string) =>
	/^[A-Za-z0-9_-]{43}$/.test(value) &&
	Buffer.from(value, "base64url").toString("base64url") === value;
export const isTelegramWebhookSecret = (value: unknown): value is string =>
	typeof value === "string" && /^[A-Za-z0-9_-]{32,256}$/.test(value);
