import { sql, type SQL } from "drizzle-orm";
import type { DataExecutor } from "../data/access.ts";
import { isMonitorId } from "../monitors/input.ts";
import type {
	StatusPageFields,
	StatusPageMutation,
	StatusPageSelection,
} from "./contracts.ts";
import { MAX_STATUS_PAGES, parseStatusPageFields } from "./input.ts";

type ErrorCode =
	| "invalid"
	| "unavailable"
	| "page_limit"
	| "slug_unavailable"
	| "empty_page";

export class StatusPageOwnerError extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode) {
		super("Status page operation could not be completed.");
		this.code = code;
	}
}

async function rows<Row>(db: DataExecutor, statement: SQL): Promise<Row[]> {
	return (await db.execute(statement)).rows as Row[];
}

function result(id: string, slug: string, oldSlug = slug): StatusPageMutation {
	return {
		id,
		slug,
		affectedSlugs: oldSlug === slug ? [slug] : [oldSlug, slug],
	};
}

/** Writes require a validated session owner. All mutation effects commit together. */
export function createStatusPageOwner(db: DataExecutor, userId: string) {
	if (!isMonitorId(userId)) throw new StatusPageOwnerError("unavailable");
	const owner = userId.toLowerCase();

	async function write<T>(
		run: (tx: DataExecutor) => Promise<T>,
		lockSlugs = false,
	) {
		if (!db.transaction) throw new StatusPageOwnerError("unavailable");
		try {
			return await db.transaction(
				async (tx) => {
					await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
					await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
					await tx.execute(
						sql`SELECT pg_advisory_xact_lock(hashtextextended(${owner}::text, 0))`,
					);
					const [account] = await rows(
						tx,
						sql`SELECT id FROM users WHERE id=${owner} FOR KEY SHARE`,
					);
					if (!account) throw new StatusPageOwnerError("unavailable");
					if (lockSlugs)
						await tx.execute(
							sql`SELECT pg_advisory_xact_lock(hashtext('status-page-slug'), 0)`,
						);
					return run(tx);
				},
				{ isolationLevel: "read committed" },
			);
		} catch (error) {
			if (error instanceof StatusPageOwnerError) throw error;
			throw new StatusPageOwnerError("unavailable");
		}
	}

	async function lockPage(tx: DataExecutor, id: string) {
		return (
			await rows<{ slug: string }>(
				tx,
				sql`
			SELECT slug FROM status_pages WHERE id=${id} AND user_id=${owner} FOR UPDATE
		`,
			)
		)[0];
	}

	async function requireAvailableSlug(tx: DataExecutor, slug: string) {
		const [row] = await rows<{ available: boolean }>(
			tx,
			sql`
			SELECT NOT EXISTS (SELECT 1 FROM status_pages WHERE lower(slug)=${slug})
				AND NOT EXISTS (
					SELECT 1 FROM slug_tombstones WHERE slug=${slug} AND released_at>clock_timestamp()
				) AS available
		`,
		);
		if (!row.available) throw new StatusPageOwnerError("slug_unavailable");
	}

	async function ownsSelection(
		tx: DataExecutor,
		selection: StatusPageSelection[],
	) {
		if (!selection.length) return true;
		const ids = sql.join(
			selection.map(({ monitorId }) => sql`${monitorId}`),
			sql`,`,
		);
		return (
			(
				await rows(
					tx,
					sql`
			SELECT id FROM monitors WHERE user_id=${owner} AND id IN (${ids})
			ORDER BY id FOR KEY SHARE
		`,
				)
			).length === selection.length
		);
	}

	async function insertSelection(
		tx: DataExecutor,
		id: string,
		selection: StatusPageSelection[],
	) {
		if (!selection.length) return;
		const values = selection.map(
			({ monitorId, showUrl }, position) =>
				sql`(${id},${monitorId},${owner},${position},${showUrl})`,
		);
		await tx.execute(sql`
			INSERT INTO status_page_monitors(status_page_id,monitor_id,user_id,position,show_url)
			VALUES ${sql.join(values, sql`,`)}
		`);
	}

	function requireFields(input: StatusPageFields) {
		const fields = parseStatusPageFields(input);
		if (!fields) throw new StatusPageOwnerError("invalid");
		return fields;
	}

	return {
		async create(input: StatusPageFields): Promise<StatusPageMutation | null> {
			const fields = requireFields(input);
			return write(async (tx) => {
				const [{ count }] = await rows<{ count: number }>(
					tx,
					sql`
					SELECT count(*)::int AS count FROM status_pages WHERE user_id=${owner}
				`,
				);
				if (count >= MAX_STATUS_PAGES)
					throw new StatusPageOwnerError("page_limit");
				if (!(await ownsSelection(tx, fields.monitors))) return null;
				await requireAvailableSlug(tx, fields.slug);
				const [{ id }] = await rows<{ id: string }>(
					tx,
					sql`
					INSERT INTO status_pages(user_id,slug,title)
					VALUES (${owner},${fields.slug},${fields.title}) RETURNING id
				`,
				);
				await insertSelection(tx, id, fields.monitors);
				return result(id, fields.slug);
			}, true);
		},
		async update(
			id: string,
			input: StatusPageFields,
		): Promise<StatusPageMutation | null> {
			if (!isMonitorId(id)) return null;
			const fields = requireFields(input);
			return write(async (tx) => {
				const page = await lockPage(tx, id);
				if (!page || !(await ownsSelection(tx, fields.monitors))) return null;
				if (page.slug !== fields.slug)
					await requireAvailableSlug(tx, fields.slug);
				await tx.execute(sql`
					UPDATE status_pages SET slug=${fields.slug},title=${fields.title}
					WHERE id=${id} AND user_id=${owner}
				`);
				await tx.execute(sql`
					DELETE FROM status_page_monitors WHERE status_page_id=${id} AND user_id=${owner}
				`);
				await insertSelection(tx, id, fields.monitors);
				return result(id, fields.slug, page.slug);
			}, true);
		},
		async setPublished(
			id: string,
			isPublished: boolean,
		): Promise<StatusPageMutation | null> {
			if (!isMonitorId(id)) return null;
			if (typeof isPublished !== "boolean")
				throw new StatusPageOwnerError("invalid");
			return write(async (tx) => {
				const page = await lockPage(tx, id);
				if (!page) return null;
				if (isPublished) {
					const [link] = await rows(
						tx,
						sql`
						SELECT 1 FROM status_page_monitors WHERE status_page_id=${id} AND user_id=${owner} LIMIT 1
					`,
					);
					if (!link) throw new StatusPageOwnerError("empty_page");
				}
				await tx.execute(sql`
					UPDATE status_pages SET is_published=${isPublished}
					WHERE id=${id} AND user_id=${owner}
				`);
				return result(id, page.slug);
			});
		},
		async remove(id: string): Promise<StatusPageMutation | null> {
			if (!isMonitorId(id)) return null;
			return write(async (tx) => {
				const [page] = await rows<{ slug: string }>(
					tx,
					sql`
					DELETE FROM status_pages WHERE id=${id} AND user_id=${owner} RETURNING slug
				`,
				);
				return page ? result(id, page.slug) : null;
			}, true);
		},
	};
}

export type StatusPageOwner = ReturnType<typeof createStatusPageOwner>;
