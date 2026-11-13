import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStatusPageOwner } from "./owner.ts";

const owner = "10000000-0000-4000-8000-000000000001";
const foreign = "10000000-0000-4000-8000-000000000002";
const firstMonitor = "a0000000-0000-4000-8000-000000000001";
const secondMonitor = "a0000000-0000-4000-8000-000000000002";
const foreignMonitor = "a0000000-0000-4000-8000-000000000003";
const draft = { title: "Our services", slug: "our-services", monitors: [] };

describe("owner status-page lifecycle", () => {
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
		await client.exec("TRUNCATE users,slug_tombstones CASCADE");
		await client.query(
			"INSERT INTO users(id,name) VALUES ($1,'Owner'),($2,'Other')",
			[owner, foreign],
		);
		await client.query(
			`INSERT INTO monitors(id,user_id,name,url,host) VALUES
				($1,$4,'First','https://first.example.invalid','first.example.invalid'),
				($2,$4,'Second','https://second.example.invalid','second.example.invalid'),
				($3,$5,'Other','https://other.example.invalid','other.example.invalid')`,
			[firstMonitor, secondMonitor, foreignMonitor, owner, foreign],
		);
	});
	afterAll(async () => {
		await client?.close();
	});

	const access = (userId = owner) => createStatusPageOwner(db, userId);
	const selected = (monitorId: string, showUrl = false) => ({
		monitorId,
		showUrl,
	});
	const state = async (id: string) =>
		(
			await client.query<{ is_published: boolean }>(
				"SELECT is_published FROM status_pages WHERE id=$1",
				[id],
			)
		).rows[0]?.is_published;

	it("creates at most three pages per owner and holds slugs globally", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 4 }, (_, i) =>
				access().create({ ...draft, slug: `service-${i}` }),
			),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
		expect(results.find((r) => r.status === "rejected")).toMatchObject({
			reason: { code: "page_limit" },
		});
		const [{ slug }] = (
			await client.query<{ slug: string }>(
				"SELECT slug FROM status_pages LIMIT 1",
			)
		).rows;
		await expect(
			access(foreign).create({ ...draft, slug }),
		).rejects.toMatchObject({ code: "slug_unavailable" });
		expect(await access(foreign).create(draft)).toMatchObject({
			slug: draft.slug,
		});
	});

	it("does not create or replace associations with a foreign monitor", async () => {
		expect(
			await access().create({
				...draft,
				monitors: [selected(foreignMonitor, true)],
			}),
		).toBeNull();
		expect((await client.query("SELECT id FROM status_pages")).rows).toEqual(
			[],
		);
		const page = await access().create({
			...draft,
			monitors: [selected(firstMonitor)],
		});
		const fields = {
			...draft,
			title: "Changed",
			monitors: [selected(secondMonitor), selected(foreignMonitor, true)],
		};
		expect(await access().update(page?.id ?? "", fields)).toBeNull();
		expect(await access(foreign).update(page?.id ?? "", fields)).toBeNull();
		expect(await access(foreign).setPublished(page?.id ?? "", true)).toBeNull();
		expect(await access(foreign).remove(page?.id ?? "")).toBeNull();
		expect((await client.query("SELECT title FROM status_pages")).rows).toEqual(
			[{ title: draft.title }],
		);
		expect(
			(
				await client.query(
					"SELECT monitor_id,show_url FROM status_page_monitors",
				)
			).rows,
		).toEqual([{ monitor_id: firstMonitor, show_url: false }]);
	});

	it("keeps nonempty replacements published and makes a page draft on final removal", async () => {
		const page = await access().create(draft);
		const id = page?.id ?? "";
		await expect(access().setPublished(id, true)).rejects.toMatchObject({
			code: "empty_page",
		});
		await access().update(id, { ...draft, monitors: [selected(firstMonitor)] });
		expect(await access().setPublished(id, true)).toMatchObject({
			affectedSlugs: [draft.slug],
		});
		await access().update(id, {
			...draft,
			monitors: [selected(secondMonitor, true)],
		});
		expect(await state(id)).toBe(true);
		expect(
			(
				await client.query(
					"SELECT monitor_id,show_url FROM status_page_monitors",
				)
			).rows,
		).toEqual([{ monitor_id: secondMonitor, show_url: true }]);
		await access().update(id, draft);
		expect(await state(id)).toBe(false);
		await access().update(id, { ...draft, monitors: [selected(firstMonitor)] });
		expect(await state(id)).toBe(false);
		await access().setPublished(id, true);
		await client.query("DELETE FROM monitors WHERE id=$1", [firstMonitor]);
		expect(await state(id)).toBe(false);
	});

	it("reserves old and deleted slugs for 30 days and allows reuse after expiry", async () => {
		const page = await access().create(draft);
		const id = page?.id ?? "";
		expect(
			await access().update(id, { ...draft, title: "Changed" }),
		).toMatchObject({
			affectedSlugs: [draft.slug],
		});
		expect(
			(await client.query("SELECT slug FROM slug_tombstones")).rows,
		).toEqual([]);
		const next = { ...draft, slug: "new-services" };
		expect(await access().update(id, next)).toMatchObject({
			slug: next.slug,
			affectedSlugs: [draft.slug, next.slug],
		});
		await expect(access(foreign).create(draft)).rejects.toMatchObject({
			code: "slug_unavailable",
		});
		await expect(access().update(id, draft)).rejects.toMatchObject({
			code: "slug_unavailable",
		});
		expect(await access().remove(id)).toMatchObject({
			affectedSlugs: [next.slug],
		});
		await expect(access(foreign).create(next)).rejects.toMatchObject({
			code: "slug_unavailable",
		});
		const { rows: expiries } = await client.query<{ seconds: number }>(
			"SELECT EXTRACT(EPOCH FROM released_at - clock_timestamp())::int AS seconds FROM slug_tombstones",
		);
		expect(expiries).toHaveLength(2);
		for (const { seconds } of expiries)
			expect(seconds).toBeGreaterThan(2_591_990);
		await client.query(
			"UPDATE slug_tombstones SET released_at=clock_timestamp() WHERE slug=$1",
			[draft.slug],
		);
		expect(await access(foreign).create(draft)).toMatchObject({
			slug: draft.slug,
		});
	});

	it("reserves slugs on a database account cascade and checks raw writes", async () => {
		await access().create({ ...draft, monitors: [selected(firstMonitor)] });
		await client.query("DELETE FROM users WHERE id=$1", [owner]);
		expect(
			(await client.query("SELECT slug FROM slug_tombstones")).rows,
		).toEqual([{ slug: draft.slug }]);
		await expect(
			client.query(
				"INSERT INTO status_pages(user_id,slug,title) VALUES ($1,$2,'Should fail')",
				[foreign, draft.slug],
			),
		).rejects.toMatchObject({ code: "23514" });
	});
});
