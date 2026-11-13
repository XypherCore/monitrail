import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	isPublishedStatusPage,
	loadPublicStatusDetails,
	loadPublicStatusSnapshot,
	overallStatus,
} from "./public-data.ts";
import { StatusView } from "./status-view.tsx";

const now = new Date("2026-06-03T12:10:00.000Z");
const dayMs = 86_400_000;
const owner = "10000000-0000-4000-8000-000000000001";
const otherOwner = "10000000-0000-4000-8000-000000000002";
const pageId = "20000000-0000-4000-8000-000000000001";
const hiddenId = "30000000-0000-4000-8000-000000000001";
const visibleId = "30000000-0000-4000-8000-000000000002";
const foreignId = "30000000-0000-4000-8000-000000000003";

describe("public status projection", () => {
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
		await client.exec("TRUNCATE users CASCADE");
		await client.query(
			"INSERT INTO users(id,name,email) VALUES ($1,'Private owner','private@example.invalid'),($2,'Other owner',null)",
			[owner, otherOwner],
		);
		await client.query(
			`INSERT INTO monitors(id,user_id,name,url,host,status,last_checked_at,created_at)
			 VALUES
			 ($1,$4,'API','https://concealed.example.invalid/private/path','concealed.example.invalid','up',$6,'2026-05-01'),
			 ($2,$4,'Website','https://shown.example.invalid/health?key=private-token#private-fragment','shown.example.invalid','up',$6,'2026-06-03T11:00Z'),
			 ($3,$5,'Foreign monitor','https://foreign.example.invalid/','foreign.example.invalid','down',$6,'2026-05-01')`,
			[hiddenId, visibleId, foreignId, owner, otherOwner, now],
		);
		await client.query(
			"INSERT INTO status_pages(id,user_id,slug,title,is_published) VALUES ($1,$2,'example-page','Example status',true)",
			[pageId, owner],
		);
		await client.query(
			"INSERT INTO status_page_monitors(status_page_id,user_id,monitor_id,position,show_url) VALUES ($1,$2,$3,1,false),($1,$2,$4,0,true)",
			[pageId, owner, hiddenId, visibleId],
		);
	});

	afterAll(async () => {
		await client?.close();
	});

	async function snapshot() {
		const value = await loadPublicStatusSnapshot(db, "example-page", now);
		if (!value) throw new Error("Expected a published status page.");
		return value;
	}

	it("returns the same absence for unknown, unpublished, and empty pages", async () => {
		expect(await isPublishedStatusPage(db, "example-page")).toBe(true);
		expect(await isPublishedStatusPage(db, "missing")).toBe(false);
		expect(await loadPublicStatusSnapshot(db, "missing", now)).toBeNull();
		await client.exec("UPDATE status_pages SET is_published=false");
		expect(await isPublishedStatusPage(db, "example-page")).toBe(false);
		expect(await loadPublicStatusSnapshot(db, "example-page", now)).toBeNull();
		await client.exec("DELETE FROM status_page_monitors");
		await client.exec("UPDATE status_pages SET is_published=true");
		expect(await isPublishedStatusPage(db, "example-page")).toBe(false);
		expect(await loadPublicStatusSnapshot(db, "example-page", now)).toBeNull();
	});

	it("orders links and projects only validated opt-in URLs with no query or fragment", async () => {
		const value = await snapshot();
		expect(value.monitors.map(({ name }) => name)).toEqual(["Website", "API"]);
		expect(value.monitors[0].url).toBe("https://shown.example.invalid/health");
		expect(value.monitors[1]).not.toHaveProperty("url");
		expect(JSON.stringify(value)).not.toMatch(
			/private-token|private-fragment|concealed\.example|foreign\.example|private@example/,
		);

		await client.query(
			"UPDATE monitors SET url='https://name:password@shown.example.invalid/health' WHERE id=$1",
			[visibleId],
		);
		const changed = await snapshot();
		expect(changed.monitors[0]).not.toHaveProperty("url");
		expect(changed.monitors[0].revision).not.toBe(value.monitors[0].revision);
	});

	it("reflects observation age on every snapshot and excludes paused and blocked monitors from precedence", async () => {
		expect(overallStatus((await snapshot()).monitors)).toBe("up");
		const stale = await loadPublicStatusSnapshot(
			db,
			"example-page",
			new Date(+now + 15 * 60_000),
		);
		expect(stale?.monitors.map(({ status }) => status)).toEqual([
			"unknown",
			"unknown",
		]);
		await client.query(
			"UPDATE monitors SET is_paused=true,pause_reason=CASE WHEN id=$1 THEN 'user' ELSE 'blocked_host' END WHERE user_id=$2",
			[visibleId, owner],
		);
		const paused = await snapshot();
		expect(paused.monitors.map(({ status }) => status)).toEqual([
			"paused",
			"blocked",
		]);
		expect(overallStatus(paused.monitors)).toBe("unknown");
		expect(
			overallStatus([
				{ status: "pending" },
				{ status: "up" },
				{ status: "confirming" },
			]),
		).toBe("confirming");
		expect(
			overallStatus([
				{ status: "unknown" },
				{ status: "down" },
				{ status: "blocked" },
			]),
		).toBe("down");
	});

	it("limits incident history to the current page and renders only allowlisted data with native details", async () => {
		await client.query(
			`INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,response_ms,status_code)
			 SELECT gen_random_uuid(),$1,1,instant,true,217,200
			 FROM generate_series('2026-06-03T11:00Z'::timestamptz,$2::timestamptz,'5 minutes') AS instant`,
			[visibleId, now],
		);
		await client.query(
			`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause)
			 VALUES ($1,$2,'2026-04-30','2026-04-30','timeout'),($3,$4,'2026-06-03','2026-06-03','tls')`,
			[hiddenId, owner, foreignId, otherOwner],
		);
		await client.query(
			`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,resolved_at,resolved_reason,cause)
			 SELECT $1,$2,instant,instant,instant+'1 minute','paused','connect'
			 FROM generate_series('2026-05-01'::timestamptz,'2026-05-13'::timestamptz,'1 day') AS instant`,
			[visibleId, owner],
		);
		const value = await snapshot();
		const details = await loadPublicStatusDetails(db, value, now);
		expect(Object.keys(details.daysByMonitor).toSorted()).toEqual([
			hiddenId,
			visibleId,
		]);
		expect(details.daysByMonitor[visibleId]).toHaveLength(30);
		expect(details.daysByMonitor[visibleId].at(-1)).toEqual({
			start: Math.floor(+now / dayMs) * dayMs,
			percent: 100,
			coverage: 1,
			incidentCount: 0,
		});
		expect(details.incidents).toHaveLength(10);
		expect(details.incidents.at(0)).toEqual({
			monitorId: visibleId,
			startedAt: "2026-05-13T00:00:00.000Z",
			resolvedAt: "2026-05-13T00:01:00.000Z",
			cause: "Connection failed",
		});
		expect(details.incidents).toEqual(
			expect.arrayContaining([
				{
					monitorId: hiddenId,
					startedAt: "2026-04-30T00:00:00.000Z",
					resolvedAt: null,
					cause: "Connection timed out",
				},
			]),
		);
		const html = renderToStaticMarkup(
			createElement(StatusView, { snapshot: value, details }),
		);
		expect(html).toContain("Example status");
		expect(html).toContain("<details");
		expect(html).toContain("Connection timed out");
		expect(html).toContain('href="https://shown.example.invalid/health"');
		expect(html).not.toMatch(
			/private-token|private-fragment|concealed\.example|Foreign monitor|private@example|30000000-0000|resolvedReason|statusCode/,
		);
	});

	it("rechecks current membership, publication, and revision for details", async () => {
		const value = await snapshot();
		await client.exec("UPDATE status_pages SET is_published=false");
		expect(await loadPublicStatusDetails(db, value, now)).toEqual({
			daysByMonitor: {},
			incidents: [],
		});
		await client.exec("UPDATE status_pages SET is_published=true");
		await client.query("DELETE FROM status_page_monitors WHERE monitor_id=$1", [
			hiddenId,
		]);
		await client.query("UPDATE monitors SET name='Changed' WHERE id=$1", [
			visibleId,
		]);
		expect(await loadPublicStatusDetails(db, value, now)).toEqual({
			daysByMonitor: {},
			incidents: [],
		});
	});
});
