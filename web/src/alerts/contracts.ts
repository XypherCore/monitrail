export type WebhookChannelType = "discord" | "slack" | "webhook";
export type ChannelType = WebhookChannelType | "telegram";

export type ChannelIdentity = { id: string; userId: string; type: ChannelType };
export type ChannelDestination = { url: string } | { chatId: string };

export type AlertErrorCategory =
	| "blocked"
	| "dns"
	| "timeout"
	| "connect"
	| "tls"
	| "bad_status"
	| "other";
export type AlertResult =
	| { ok: true }
	| { ok: false; category: AlertErrorCategory };

export type AlertSender = (
	input: ChannelIdentity & { configEnc: string; payload: unknown },
) => Promise<AlertResult>;
