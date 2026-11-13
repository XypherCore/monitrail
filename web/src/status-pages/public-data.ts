import { sql, type SQL } from "drizzle-orm";
import { parseTarget } from "../../../shared/ssrf/address.ts";
import {
	DataAccessError,
	type DataExecutor,
	displayStatus,
	type IncidentDto,
	type MonitorDto,
	monitorStateFields,
} from "../data/access.ts";
import {
	type HistoryInput,
	MONITOR_RANGES,
} from "../monitors/insight-types.ts";
import {
	buildAvailabilityDays,
	firstAvailabilityDay,
} from "../monitors/insights.ts";
import type { PublicStatusDetails, PublicStatusSnapshot } from "./contracts.ts";

const activePriority = [
	"down",
	"unknown",
	"confirming",
	"pending",
	"up",
] as const;

const causes: Record<IncidentDto["cause"], string> = {
	blocked: "Connection blocked",
	dns: "DNS lookup failed",
	timeout: "Connection timed out",
	tls: "Secure connection failed",
	connect: "Connection failed",
	bad_status: "Unexpected HTTP status",
	other: "Check failed",
};

export function overallStatus(monitors: { status: MonitorDto["status"] }[]) {
	return (
		activePriority.find((status) =>
			monitors.some((monitor) => monitor.status === status),
		) ?? "unknown"
	);
}

function publicUrl(value: string | null): string | undefined {
	if (value === null) return;
	try {
		const url = parseTarget(value);
		return url.origin + url.pathname;
	} catch {
		// Some stored data predates URL admission checks.
		return;
	}
}

async function readRows<Row>(db: DataExecutor, statement: SQL): Promise<Row[]> {
	try {
		return (await db.execute(statement)).rows as Row[];
	} catch {
		throw new DataAccessError();
	}
}

export async function isPublishedStatusPage(db: DataExecutor, slug: string): Promise<boolean> {
	const [page] = await readRows<{ available: boolean }>(db, sql`
		SELECT EXISTS (
			SELECT 1 FROM status_pages p
			JOIN status_page_monitors l ON l.status_page_id=p.id AND l.user_id=p.user_id
			JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id
			WHERE lower(p.slug)=${slug} AND p.is_published
		) AS available
	`);
	return page.available;
}

type SnapshotRow = Record<string, unknown> & {
	pageId: string;
	slug: string;
	title: string;
	id: string;
	revision: string;
	name: string;
	url: string | null;
};

/** Read live publication, membership, and visibility without a session or cache. */
export async function loadPublicStatusSnapshot(
	db: DataExecutor,
	slug: string,
	now: Date,
): Promise<PublicStatusSnapshot | null> {
	const rows = await readRows<SnapshotRow>(
		db,
		sql`
		SELECT p.id AS "pageId",p.slug,p.title,m.id,m.xmin::text AS revision,m.name,
			CASE WHEN l.show_url THEN m.url END AS url,${monitorStateFields}
		FROM status_pages p
		JOIN status_page_monitors l ON l.status_page_id=p.id AND l.user_id=p.user_id
		JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id
		WHERE lower(p.slug)=${slug} AND p.is_published
		ORDER BY l.position,m.id
	`,
	);
	const page = rows[0];
	if (!page) return null;
	return {
		pageId: page.pageId,
		slug: page.slug,
		title: page.title,
		monitors: rows.map((row) => {
			const url = publicUrl(row.url);
			return {
				id: row.id,
				revision: row.revision,
				name: row.name,
				status: displayStatus(row, now),
				...(url ? { url } : {}),
			};
		}),
	};
}

type HistoryRow = {
	id: string;
	createdAt: string;
	intervalSeconds: number;
	isPaused: boolean;
	checks: string[];
	events: { at: string; kind: HistoryInput["events"][number]["kind"] }[];
	incidents: { startedAt: string; resolvedAt: string | null }[];
};

type DetailsRow = {
	histories: HistoryRow[];
	incidents: {
		monitorId: string;
		startedAt: string;
		resolvedAt: string | null;
		cause: IncidentDto["cause"];
	}[];
};

function historyInput(row: HistoryRow): HistoryInput {
	return {
		createdAt: new Date(row.createdAt),
		intervalSeconds: row.intervalSeconds,
		isPaused: row.isPaused,
		// Only the presence and time of a check affect availability.
		checks: row.checks.map((checkedAt) => ({
			checkedAt: new Date(checkedAt),
			ok: false,
			responseMs: null,
		})),
		events: row.events.map(({ at, kind }) => ({ at: new Date(at), kind })),
		incidents: row.incidents.map(({ startedAt, resolvedAt }) => ({
			startedAt: new Date(startedAt),
			resolvedAt: resolvedAt === null ? null : new Date(resolvedAt),
		})),
	};
}

/** Load only the history needed for the public bar and incident list. */
export async function loadPublicStatusDetails(
	db: DataExecutor,
	snapshot: PublicStatusSnapshot,
	now: Date,
): Promise<PublicStatusDetails> {
	if (snapshot.monitors.length === 0)
		return { daysByMonitor: {}, incidents: [] };
	const requested = sql.join(
		snapshot.monitors.map(
			({ id, revision }) => sql`(${id}::uuid,${revision}::text)`,
		),
		sql`,`,
	);
	const start = sql`greatest(${new Date(firstAvailabilityDay(now)).toISOString()}::timestamptz,m.created_at)`;
	const end = sql`${now.toISOString()}::timestamptz`;
	const recent = sql`${new Date(+now - MONITOR_RANGES["30d"].durationMs).toISOString()}::timestamptz`;
	const [details] = await readRows<DetailsRow>(
		db,
		sql`
		WITH requested(id,revision) AS (VALUES ${requested}),
		linked AS MATERIALIZED (
			SELECT m.id,m.user_id,m.created_at,m.interval_seconds,m.is_paused
			FROM status_pages p
			JOIN status_page_monitors l ON l.status_page_id=p.id AND l.user_id=p.user_id
			JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id
			JOIN requested r ON r.id=m.id AND r.revision=m.xmin::text
			WHERE p.id=${snapshot.pageId} AND p.slug=${snapshot.slug} AND p.is_published
		),
		history AS (
			SELECT m.id,m.created_at AS "createdAt",m.interval_seconds AS "intervalSeconds",
				m.is_paused AS "isPaused",
				COALESCE((
					SELECT jsonb_agg(c.checked_at ORDER BY c.checked_at,c.id)
					FROM (
						SELECT c.id,c.checked_at FROM checks c
						WHERE c.monitor_id=m.id AND c.checked_at BETWEEN ${start} AND ${end}
						UNION ALL (
							SELECT c.id,c.checked_at FROM checks c WHERE c.monitor_id=m.id
							AND c.checked_at >= m.created_at AND c.checked_at < ${start}
							ORDER BY c.checked_at DESC,c.id DESC LIMIT 1
						)
					) c
				),'[]'::jsonb) AS checks,
				COALESCE((
					SELECT jsonb_agg(jsonb_build_object('at',e.at,'kind',e.kind) ORDER BY e.at,e.id)
					FROM (
						SELECT e.id,e.at,e.kind FROM monitor_events e WHERE e.monitor_id=m.id
						AND e.kind IN ('paused','resumed','blocked') AND e.at BETWEEN ${start} AND ${end}
						UNION ALL (
							SELECT e.id,e.at,e.kind FROM monitor_events e WHERE e.monitor_id=m.id
							AND e.kind IN ('paused','resumed','blocked') AND e.at < ${start}
							ORDER BY e.at DESC,e.id DESC LIMIT 1
						)
					) e
				),'[]'::jsonb) AS events,
				COALESCE((
					SELECT jsonb_agg(jsonb_build_object('startedAt',i.started_at,'resolvedAt',i.resolved_at)
						ORDER BY i.started_at,i.id)
					FROM incidents i WHERE i.monitor_id=m.id AND i.user_id=m.user_id
						AND i.started_at <= ${end} AND (i.resolved_at IS NULL OR i.resolved_at > ${start})
				),'[]'::jsonb) AS incidents
			FROM linked m
		),
		recent_incidents AS (
			SELECT i.id,i.monitor_id,i.started_at,i.resolved_at,i.cause
			FROM incidents i JOIN linked m ON m.id=i.monitor_id AND m.user_id=i.user_id
			WHERE i.started_at <= ${end} AND (i.resolved_at IS NULL OR i.resolved_at > ${recent})
			ORDER BY i.started_at DESC,i.id LIMIT 10
		)
		SELECT COALESCE((SELECT jsonb_agg(h) FROM history h),'[]'::jsonb) AS histories,
			COALESCE((SELECT jsonb_agg(
				jsonb_build_object('monitorId',i.monitor_id,'startedAt',i.started_at,'resolvedAt',i.resolved_at,'cause',i.cause)
				ORDER BY i.started_at DESC,i.id
			) FROM recent_incidents i),'[]'::jsonb) AS incidents
	`,
	);
	return {
		daysByMonitor: Object.fromEntries(
			details.histories.map((row) => [
				row.id,
				buildAvailabilityDays(historyInput(row), now),
			]),
		),
		incidents: details.incidents.map(
			({ monitorId, startedAt, resolvedAt, cause }) => ({
				monitorId,
				startedAt: new Date(startedAt).toISOString(),
				resolvedAt:
					resolvedAt === null ? null : new Date(resolvedAt).toISOString(),
				cause: causes[cause],
			}),
		),
	};
}
