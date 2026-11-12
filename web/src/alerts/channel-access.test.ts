import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { createAlertChannelAccess } from "./channel-access.ts";
import { createChannelCipher } from "./channel-crypto.ts";
import type { AlertResult } from "./contracts.ts";
import { createTelegramLinker } from "./telegram-link.ts";

const owner = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const target = "https://receiver.example.invalid/fixture-destination";
const cipher = () =>
	createChannelCipher({
		CHANNEL_ENC_KEY_ID: "test",
		CHANNEL_ENC_KEY: Buffer.alloc(32, 7).toString("base64url"),
	});
const inputs = { type: "webhook", label: "Test channel", url: target } as const;

describe("owner-bound alert channels", () => {
	let client: PGlite;
	let db: ReturnType<typeof drizzle>;

	beforeAll(async () => {
		client = new PGlite();
		db = drizzle(client);
		await migrate(db, {
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-rev2", import.meta.url),
			),
		});
	}, 30_000);
	beforeEach(async () => {
		await client.exec("TRUNCATE users,rate_limits CASCADE");
		await client.query("INSERT INTO users(id,name) VALUES ($1,'A'),($2,'B')", [
			owner,
			other,
		]);
	});
	afterAll(async () => {
		await client?.close();
	});

	function setup(userId = owner, outcome: AlertResult = { ok: true }) {
		const send = vi.fn(async () => outcome);
		const validateWebhook = vi.fn(async () => ({
			url: target,
			host: "receiver.example.invalid",
		}));
		return {
			send,
			validateWebhook,
			access: createAlertChannelAccess(db, userId, {
				cipher,
				validateWebhook,
				send,
				telegramUsername: () => "fixture_test_bot",
			}),
		};
	}

	it("encrypts the immutable destination and verifies only after a successful test", async () => {
		const initial = setup(owner, { ok: false, category: "timeout" });
		const { id } = await initial.access.create(inputs);
		const {
			rows: [before],
		} = await client.query<{ config_enc: string; is_verified: boolean }>(
			"SELECT config_enc,is_verified FROM alert_channels WHERE id=$1",
			[id],
		);
		expect(before.is_verified).toBe(false);
		expect(before.config_enc).not.toContain(target);
		expect(
			cipher().decrypt(before.config_enc, {
				id,
				userId: owner,
				type: "webhook",
			}),
		).toEqual({ url: target });
		expect(await initial.access.test(id)).toEqual({
			ok: false,
			category: "timeout",
		});
		expect(
			(await client.query("SELECT 1 FROM alert_channels WHERE is_verified"))
				.rows,
		).toEqual([]);
		const passing = setup();
		expect(await passing.access.test(id)).toEqual({ ok: true });
		expect(passing.send).toHaveBeenCalledWith(
			expect.objectContaining({
				id,
				payload: expect.objectContaining({ version: 1, event: "alert.test" }),
			}),
		);
		expect(
			(await client.query("SELECT 1 FROM alert_channels WHERE is_verified"))
				.rows,
		).toHaveLength(1);
	});

	it("rejects another owner's IDs before consuming rate limits or sending", async () => {
		const { id } = await setup(other).access.create(inputs);
		const { access, send } = setup();
		expect(await access.test(id)).toBeNull();
		expect(await access.rename(id, "Changed")).toBe(false);
		expect(await access.remove(id)).toBe(false);
		expect(send).not.toHaveBeenCalled();
		expect(
			(
				await client.query(
					"SELECT 1 FROM rate_limits WHERE key LIKE 'alert-test:%'",
				)
			).rows,
		).toEqual([]);
	});

	it("enforces channel and rolling per-user/per-channel test quotas", async () => {
		const { access, send } = setup();
		const [first, second, third] = await Promise.all([
			access.create(inputs),
			access.create(inputs),
			access.create(inputs),
		]);
		await expect(access.create(inputs)).rejects.toMatchObject({
			code: "channel_limit",
		});
		for (let i = 0; i < 3; i += 1) await access.test(first.id);
		await expect(access.test(first.id)).rejects.toMatchObject({
			code: "rate_limit",
		});
		await access.test(second.id);
		await access.test(second.id);
		await expect(access.test(third.id)).rejects.toMatchObject({
			code: "rate_limit",
		});
		expect(send).toHaveBeenCalledTimes(5);
	});

	it("shares the owner's existing URL-validation budget before DNS", async () => {
		await client.query(
			"INSERT INTO rate_limits(key,window_start,count) VALUES ($1,clock_timestamp(),30)",
			[`monitor-url:${owner}`],
		);
		const { access, validateWebhook } = setup();
		await expect(access.create(inputs)).rejects.toMatchObject({
			code: "rate_limit",
		});
		expect(validateWebhook).not.toHaveBeenCalled();
	});

	it("stores only the code hash and atomically consumes once into an encrypted verified private channel", async () => {
		const { access } = setup();
		const issued = await access.issueTelegram();
		const code = new URL(issued.url).searchParams.get("start") as string;
		const { rows } = await client.query<{
			code_hash: string;
			used_at: Date | null;
		}>("SELECT code_hash,used_at FROM telegram_link_codes");
		expect(rows[0]).toEqual({
			code_hash: createHash("sha256").update(code).digest("hex"),
			used_at: null,
		});
		const linker = createTelegramLinker(db, cipher);
		const link = () =>
			linker.handleTelegramWebhook({
				code,
				chatId: "883345672",
				chatType: "private",
			});
		expect(await link()).toEqual({ linked: true });
		expect(await link()).toEqual({ linked: false });
		const {
			rows: [row],
		} = await client.query<{
			id: string;
			config_enc: string;
			is_verified: boolean;
		}>(
			"SELECT id,config_enc,is_verified FROM alert_channels WHERE type='telegram'",
		);
		expect(row.is_verified).toBe(true);
		expect(row.config_enc).not.toContain("883345672");
		expect(
			cipher().decrypt(row.config_enc, {
				id: row.id,
				userId: owner,
				type: "telegram",
			}),
		).toEqual({ chatId: "883345672" });
	});

	it("rejects expired codes and throttles code issuance", async () => {
		const { access } = setup();
		const issued = await access.issueTelegram();
		const code = new URL(issued.url).searchParams.get("start") as string;
		await client.exec(
			"UPDATE telegram_link_codes SET expires_at=clock_timestamp()-interval '1 second'",
		);
		const linker = createTelegramLinker(db, cipher);
		expect(
			await linker.handleTelegramWebhook({
				code,
				chatId: "123",
				chatType: "private",
			}),
		).toEqual({ linked: false });
		expect(
			(await client.query("SELECT 1 FROM alert_channels")).rows,
		).toHaveLength(0);
		for (let i = 0; i < 4; i += 1) await access.issueTelegram();
		await expect(access.issueTelegram()).rejects.toMatchObject({
			code: "rate_limit",
		});
	});
});
