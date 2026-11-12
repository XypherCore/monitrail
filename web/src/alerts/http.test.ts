import { describe, expect, it, vi } from "vitest";
import { createAlertHandlers } from "./http.ts";
import { createTelegramWebhookHandler } from "./telegram-http.ts";

const origin = "https://app.example.invalid";
const id = "10000000-0000-4000-8000-000000000001";
const secret = "synthetic-telegram-authentication-fixture";
const code = Buffer.alloc(32, 1).toString("base64url");

function update(type = "private", fromId = 1234, text = `/start ${code}`) {
	return {
		update_id: 1,
		message: {
			text,
			from: { id: fromId, is_bot: false },
			chat: { id: 1234, type },
		},
	};
}

describe("alert mutation boundaries", () => {
	const create = vi.fn(async () => ({ id }));
	const access = {
		create,
		rename: vi.fn(async () => true),
		remove: vi.fn(async () => true),
		test: vi.fn(async () => ({ ok: false, category: "timeout" }) as const),
		issueTelegram: vi.fn(async () => ({
			url: "https://t.me/fixture_bot",
			expiresAt: new Date(),
		})),
	};
	const handlers = createAlertHandlers({
		origin: () => origin,
		authenticate: async () => access,
	});
	const body = {
		type: "webhook",
		label: "Example",
		url: "https://example.invalid/private",
	};
	const request = (value: unknown, from = origin) =>
		new Request(`${origin}/api/channels`, {
			method: "POST",
			headers: { origin: from, "content-type": "application/json" },
			body: JSON.stringify(value),
		});

	it("rejects cross-origin mutations, unknown input and oversized bodies before access", async () => {
		create.mockClear();
		expect(
			(
				await handlers.create(
					request(body, "https://untrusted.example.invalid"),
				)
			).status,
		).toBe(403);
		expect(
			(await handlers.create(request({ ...body, userId: id }))).status,
		).toBe(400);
		expect(
			(await handlers.create(request({ ...body, url: "a".repeat(9000) })))
				.status,
		).toBe(413);
		expect(create).not.toHaveBeenCalled();
	});

	it("returns only the new channel ID and an allowlisted failure category", async () => {
		const saved = await handlers.create(request(body));
		expect(saved.status).toBe(201);
		expect(saved.headers.get("cache-control")).toContain("no-store");
		expect(await saved.json()).toEqual({ id });
		const tested = await handlers.test(
			new Request(`${origin}/api/channels/${id}/test`, {
				method: "POST",
				headers: { origin },
			}),
			id,
		);
		expect(tested.status).toBe(422);
		expect(await tested.json()).toMatchObject({
			error: { category: "timeout" },
		});
	});
});

describe("Telegram inbound boundary", () => {
	it("authenticates before parsing and ignores unverified, group and forwarded starts", async () => {
		const link = vi.fn(async () => ({ linked: true }));
		const handle = createTelegramWebhookHandler({ secret: () => secret, link });
		const request = (body: unknown, token = secret) =>
			new Request(`${origin}/api/telegram/webhook`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-telegram-bot-api-secret-token": token,
				},
				body: JSON.stringify(body),
			});
		expect((await handle(request(update(), "wrong"))).status).toBe(404);
		expect((await handle(request(update("group")))).status).toBe(200);
		expect((await handle(request(update("private", 4567)))).status).toBe(200);
		expect(
			(await handle(request(update("private", 1234, `/start ${code} extra`))))
				.status,
		).toBe(200);
		const forwarded = update();
		expect(
			(
				await handle(
					request({
						...forwarded,
						message: { ...forwarded.message, forward_origin: {} },
					}),
				)
			).status,
		).toBe(200);
		expect(link).not.toHaveBeenCalled();
		const accepted = await handle(request(update()));
		expect(accepted.status).toBe(200);
		expect(accepted.headers.get("cache-control")).toContain("no-store");
		expect(await accepted.text()).toBe("");
		expect(link).toHaveBeenCalledExactlyOnceWith({
			code,
			chatId: "1234",
			chatType: "private",
		});
	});
});
