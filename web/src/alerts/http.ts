import { WebGuardError } from "../security/web-ssrf.ts";
import { MANAGEMENT_WRITE_LIMIT, ManagementRateError } from "../security/management-rate.ts";
import type { createAlertChannelAccess } from "./channel-access.ts";
import { AlertAccessError, CHANNEL_LIMIT } from "./channel-store.ts";
import {
	channelCreateInput,
	channelRenameInput,
	isChannelId,
} from "./channel-input.ts";
import type { AlertErrorCategory } from "./contracts.ts";
import {
	alertPrivateHeaders,
	AlertRequestError,
	readAlertJson,
	requireEmptyAlertBody,
} from "./request-json.ts";

type AlertAccess = ReturnType<typeof createAlertChannelAccess>;
type Dependencies = {
	origin(): string;
	authenticate(request: Request, origin: string): Promise<AlertAccess | null>;
};

const headers = { ...alertPrivateHeaders, vary: "Cookie" };
const invalid = () => failure(400, "Enter valid channel settings.");
const missing = () => failure(404, "Channel not found.");
const unavailable = () =>
	failure(503, "Alert channels are temporarily unavailable. Try again.");
const messages: Record<AlertErrorCategory, string> = {
	blocked: "This destination is blocked.",
	dns: "The destination could not be safely resolved.",
	timeout: "The destination did not respond in time.",
	connect: "The connection failed.",
	tls: "The secure connection failed.",
	bad_status: "The destination rejected the alert.",
	other: "The alert could not be sent.",
};

function failure(
	status: number,
	message: string,
	category?: AlertErrorCategory,
) {
	return Response.json({ error: { message, category } }, { status, headers });
}

function respond(value: object, status = 200) {
	return Response.json(value, { status, headers });
}

export function createAlertHandlers(deps: Dependencies) {
	async function run(
		request: Request,
		method: "POST" | "PATCH" | "DELETE",
		action: (access: AlertAccess) => Promise<Response>,
	) {
		if (request.method !== method) {
			const response = failure(405, "Unsupported request method.");
			response.headers.set("allow", method);
			return response;
		}
		try {
			const origin = deps.origin();
			if (request.headers.get("origin") !== origin)
				return failure(403, "This request must come from the app.");
			const access = await deps.authenticate(request, origin);
			if (!access) return failure(401, "Sign in to manage alert channels.");
			return await action(access);
		} catch (error) {
			if (error instanceof ManagementRateError) {
				const response = failure(429, `You can make up to ${MANAGEMENT_WRITE_LIMIT} management changes per hour. Try again in ${error.retryAfterSeconds} seconds.`);
				response.headers.set("retry-after", String(error.retryAfterSeconds));
				return response;
			}
			if (error instanceof AlertRequestError)
				return failure(error.status, "Invalid channel request.");
			if (error instanceof WebGuardError)
				return failure(422, messages[error.code], error.code);
			if (!(error instanceof AlertAccessError)) return unavailable();
			if (error.code === "invalid") return invalid();
			if (error.code === "channel_limit")
				return failure(
					409,
					`You can have up to ${CHANNEL_LIMIT} alert channels.`,
				);
			if (error.code === "telegram_unavailable")
				return failure(503, "Telegram linking is temporarily unavailable.");
			if (error.code === "rate_limit") {
				const retry = error.retryAfterSeconds ?? 1;
				const minutes = Math.ceil(retry / 60);
				const response = failure(
					429,
					`The hourly limit was reached. Try again in about ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
				);
				response.headers.set("retry-after", String(retry));
				return response;
			}
			return unavailable();
		}
	}
	return {
		create: (request: Request) =>
			run(request, "POST", async (access) => {
				const input = channelCreateInput(await readAlertJson(request));
				return input ? respond(await access.create(input), 201) : invalid();
			}),
		rename: (request: Request, id: string) =>
			run(request, "PATCH", async (access) => {
				if (!isChannelId(id)) return missing();
				const label = channelRenameInput(await readAlertJson(request));
				if (!label) return invalid();
				return (await access.rename(id, label)) ? respond({ id }) : missing();
			}),
		remove: (request: Request, id: string) =>
			run(request, "DELETE", async (access) => {
				await requireEmptyAlertBody(request);
				return isChannelId(id) && (await access.remove(id))
					? respond({ id })
					: missing();
			}),
		test: (request: Request, id: string) =>
			run(request, "POST", async (access) => {
				await requireEmptyAlertBody(request);
				if (!isChannelId(id)) return missing();
				const result = await access.test(id);
				if (!result) return missing();
				return result.ok
					? respond({ id, verified: true })
					: failure(422, messages[result.category], result.category);
			}),
		telegram: (request: Request) =>
			run(request, "POST", async (access) => {
				await requireEmptyAlertBody(request);
				return respond(await access.issueTelegram(), 201);
			}),
	};
}
