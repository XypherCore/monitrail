import { sql, type SQL } from "drizzle-orm";
import {
  type HistoryInput,
  MONITOR_RANGES,
  type MonitorInsights,
  type MonitorRange,
  type MonitorSummaryMetrics,
} from "../monitors/insight-types.ts";
import { buildMonitorInsights, summarizeMonitor } from "../monitors/insights.ts";
import { displayMonitorUrl } from "./display-url.ts";

/** The authenticated user boundary supplies this server-side database handle. */
export type DataExecutor = {
  execute(statement: SQL): PromiseLike<{ rows: unknown[] }>;
  transaction?<T>(
    action: (tx: DataExecutor) => Promise<T>,
    config?: { isolationLevel: "read committed" },
  ): Promise<T>;
};
export type DataPage = { limit?: number; offset?: number };
export type MonitorDto = {
  id: string;
  name: string;
  url: string;
  status: "pending" | "confirming" | "up" | "down" | "paused" | "blocked" | "unknown";
  isPaused: boolean;
  intervalSeconds: number;
  expectedStatus: string;
  lastCheckedAt: Date | null;
};
type OpenIncident = { openIncidentStartedAt: Date | null };
type MonitorSummary = MonitorDto & MonitorSummaryMetrics & OpenIncident;
type MonitorDetail = { monitor: MonitorDto; insights: MonitorInsights } & OpenIncident;
export type ChannelDto = {
  id: string;
  type: "telegram" | "webhook" | "discord" | "slack";
  label: string;
  isVerified: boolean;
  createdAt: Date;
};
export type IncidentDto = {
  id: string;
  monitorId: string;
  startedAt: Date;
  confirmedAt: Date;
  resolvedAt: Date | null;
  resolvedConfirmedAt: Date | null;
  resolvedReason: "recovered" | "paused" | "config_changed" | "blocked" | null;
  cause: "dns" | "timeout" | "tls" | "connect" | "bad_status" | "blocked" | "other";
};
export type StatusPageDto = {
  id: string;
  slug: string;
  title: string;
  isPublished: boolean;
  createdAt: Date;
};
export type CheckDto = {
  id: string;
  monitorId: string;
  checkedAt: Date;
  ok: boolean;
  statusCode: number | null;
  responseMs: number | null;
  errorType: IncidentDto["cause"] | null;
};
export type PageMonitorDto = {
  monitorId: string;
  name: string;
  status: MonitorDto["status"];
  position: number;
  showUrl: boolean;
};
export type AlertOutboxDto = {
  id: string;
  incidentId: string;
  channelId: string;
  kind: "down" | "up";
  status: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  sentAt: Date | null;
};

export class DataAccessError extends Error {
  constructor() {
    super("Data access failed.");
    this.name = "DataAccessError";
  }
}

type Row = Record<string, unknown>;
const maxPageMonitors = 10;
const maxMonitorChannels = 3;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw new DataAccessError();
}
function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new DataAccessError();
}
function ids(values: readonly string[], limit: number): void {
  if (!Array.isArray(values) || values.length > limit) {
    throw new DataAccessError();
  }
  for (const value of values) requireId(value);
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new DataAccessError();
  }
}
function pageBounds(page: DataPage = {}): { limit: number; offset: number } {
  const limit = page.limit ?? 100;
  const offset = page.offset ?? 0;
  // Query work is bounded independently of product quotas.
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new DataAccessError();
  return { limit, offset };
}
function date(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== "string") throw new DataAccessError();
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new DataAccessError();
  return result;
}
function optionalDate(value: unknown): Date | null {
  return value === null ? null : date(value);
}
async function rows(db: DataExecutor, statement: SQL): Promise<Row[]> {
  try {
    const result = await db.execute(statement);
    if (
      !Array.isArray(result.rows) ||
      result.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    ) {
      throw new DataAccessError();
    }
    return result.rows as Row[];
  } catch {
    // Statements, driver errors and credential-bearing values stay private.
    throw new DataAccessError();
  }
}

const monitorStateFields = sql`m.status,m.is_paused AS "isPaused",m.pause_reason AS "pauseReason",m.interval_seconds AS "intervalSeconds",m.last_checked_at AS "lastCheckedAt",m.failures,m.successes,
  CASE WHEN m.last_checked_at IS NULL AND NOT m.is_paused THEN greatest(m.created_at, (
    SELECT max(e.at) FROM monitor_events e WHERE e.monitor_id=m.id AND e.kind IN ('resumed','config_changed')
  )) END AS "observationStartedAt"`;
const monitorFields = sql`m.id,m.name,m.url,m.expected_status AS "expectedStatus",${monitorStateFields}`;
const channelFields = sql`c.id,c.type,c.label,c.is_verified AS "isVerified",c.created_at AS "createdAt"`;
const incidentFields = sql`i.id,i.monitor_id AS "monitorId",i.started_at AS "startedAt",i.confirmed_at AS "confirmedAt",i.resolved_at AS "resolvedAt",i.resolved_confirmed_at AS "resolvedConfirmedAt",i.resolved_reason AS "resolvedReason",i.cause`;
const pageFields = sql`p.id,p.slug,p.title,p.is_published AS "isPublished",p.created_at AS "createdAt"`;

function displayStatus(row: Row, now: Date): MonitorDto["status"] {
  if (row.isPaused) return row.pauseReason === "blocked_host" ? "blocked" : "paused";
  const lastCheckedAt = optionalDate(row.lastCheckedAt);
  if (!lastCheckedAt) {
    return now.getTime() - date(row.observationStartedAt).getTime() >= 10 * 60 * 1000
      ? "unknown"
      : "pending";
  }
  if (now.getTime() - lastCheckedAt.getTime() >= Number(row.intervalSeconds) * 3 * 1000)
    return "unknown";
  if (
    (row.status === "down" && row.successes === 1) ||
    ((row.status === "pending" || row.status === "up") && row.failures === 1)
  )
    return "confirming";
  if (row.status !== "pending" && row.status !== "up" && row.status !== "down")
    throw new DataAccessError();
  return row.status;
}
function monitor(row: Row, now: Date): MonitorDto {
  return {
    id: String(row.id),
    name: String(row.name),
    url: displayMonitorUrl(String(row.url)),
    status: displayStatus(row, now),
    isPaused: row.isPaused as boolean,
    intervalSeconds: row.intervalSeconds as number,
    expectedStatus: String(row.expectedStatus),
    lastCheckedAt: optionalDate(row.lastCheckedAt),
  };
}
function monitorHistory(row: Row): HistoryInput {
  return {
    createdAt: date(row.createdAt),
    intervalSeconds: row.intervalSeconds as number,
    isPaused: row.isPaused as boolean,
    checks: (row.checks as Row[]).map((check) => ({
      checkedAt: date(check.checkedAt),
      ok: check.ok as boolean,
      responseMs: check.responseMs as number | null,
    })),
    events: (row.events as Row[]).map((event) => ({
      at: date(event.at),
      kind: event.kind as HistoryInput["events"][number]["kind"],
    })),
    incidents: (row.incidents as Row[]).map((incident) => ({
      startedAt: date(incident.startedAt),
      resolvedAt: optionalDate(incident.resolvedAt),
    })),
  };
}
function openIncidentStartedAt(history: HistoryInput): Date | null {
  return history.incidents.find((incident) => incident.resolvedAt === null)?.startedAt ?? null;
}
function channel(row: Row): ChannelDto {
  return {
    id: String(row.id),
    type: row.type as ChannelDto["type"],
    label: String(row.label),
    isVerified: row.isVerified as boolean,
    createdAt: date(row.createdAt),
  };
}
function incident(row: Row): IncidentDto {
  return {
    id: String(row.id),
    monitorId: String(row.monitorId),
    startedAt: date(row.startedAt),
    confirmedAt: date(row.confirmedAt),
    resolvedAt: optionalDate(row.resolvedAt),
    resolvedConfirmedAt: optionalDate(row.resolvedConfirmedAt),
    resolvedReason: row.resolvedReason as IncidentDto["resolvedReason"],
    cause: row.cause as IncidentDto["cause"],
  };
}
function statusPage(row: Row): StatusPageDto {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    isPublished: row.isPublished as boolean,
    createdAt: date(row.createdAt),
  };
}

/** Bind once to the session UUID. Every returned projection omits private storage fields. */
export function createDataAccess(db: DataExecutor, userId: string, currentTime = () => new Date()) {
  requireId(userId);
  userId = userId.toLowerCase();
  const ownedRows = (statement: SQL) => rows(db, statement);
  const changed = async (statement: SQL) => (await ownedRows(statement)).length === 1;
  const first = <T>(found: T[]) => found[0] ?? null;
  const monitors = (found: Row[]) => {
    const now = date(currentTime());
    return found.map((row) => monitor(row, now));
  };

  async function loadMonitorHistory(now: Date, durationMs: number, monitorId?: string) {
    const end = sql`${now.toISOString()}::timestamptz`;
    const start = sql`greatest(${new Date(now.getTime() - durationMs).toISOString()}::timestamptz, m.created_at)`;
    const selected = monitorId === undefined ? sql`` : sql`AND m.id=${monitorId}`;
    // Keep the monitor and its history in one statement snapshot. The indexed
    // predecessor rows carry coverage and pause state across the left edge.
    return ownedRows(sql`
      SELECT ${monitorFields},m.created_at AS "createdAt",
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('checkedAt', c.checked_at, 'ok', c.ok,
            'responseMs', c.response_ms) ORDER BY c.checked_at,c.id)
          FROM (
            SELECT c.id,c.checked_at,c.ok,c.response_ms FROM checks c
            WHERE c.monitor_id=m.id AND c.checked_at BETWEEN ${start} AND ${end}
            UNION ALL (
              SELECT c.id,c.checked_at,c.ok,c.response_ms FROM checks c
              WHERE c.monitor_id=m.id AND c.checked_at >= m.created_at AND c.checked_at < ${start}
              ORDER BY c.checked_at DESC,c.id DESC LIMIT 1
            )
          ) c
        ),'[]'::jsonb) AS checks,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind) ORDER BY e.at,e.id)
          FROM (
            SELECT e.id,e.at,e.kind FROM monitor_events e
            WHERE e.monitor_id=m.id AND e.kind IN ('paused','resumed','blocked')
              AND e.at BETWEEN ${start} AND ${end}
            UNION ALL (
              SELECT e.id,e.at,e.kind FROM monitor_events e
              WHERE e.monitor_id=m.id AND e.kind IN ('paused','resumed','blocked') AND e.at < ${start}
              ORDER BY e.at DESC,e.id DESC LIMIT 1
            )
          ) e
        ),'[]'::jsonb) AS events,
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('startedAt', i.started_at, 'resolvedAt', i.resolved_at)
            ORDER BY i.started_at,i.id)
          FROM incidents i
          WHERE i.monitor_id=m.id AND i.user_id=m.user_id AND i.started_at <= ${end}
            AND (i.resolved_at IS NULL OR i.resolved_at > ${start})
        ),'[]'::jsonb) AS incidents
      FROM monitors m WHERE m.user_id=${userId} ${selected} ORDER BY m.name,m.id
    `);
  }

  async function associationWrite<T>(action: (tx: DataExecutor) => Promise<T>): Promise<T> {
    if (!db.transaction) throw new DataAccessError();
    try {
      return await db.transaction(
        async (tx) => {
          await rows(tx, sql`SET LOCAL lock_timeout = '2s'`);
          await rows(tx, sql`SET LOCAL statement_timeout = '5s'`);
          await rows(tx, sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text,0))`);
          return action(tx);
        },
        { isolationLevel: "read committed" },
      );
    } catch {
      throw new DataAccessError();
    }
  }

  const lockMonitor = async (tx: DataExecutor, monitorId: string) =>
    (
      await rows(
        tx,
        sql`SELECT id FROM monitors WHERE id=${monitorId} AND user_id=${userId} FOR UPDATE`,
      )
    ).length === 1;
  const lockPage = async (tx: DataExecutor, pageId: string) =>
    (
      await rows(
        tx,
        sql`SELECT id FROM status_pages WHERE id=${pageId} AND user_id=${userId} FOR UPDATE`,
      )
    ).length === 1;

  return {
    async listMonitors(page?: DataPage): Promise<MonitorDto[]> {
      const { limit, offset } = pageBounds(page);
      return monitors(
        await ownedRows(
          sql`SELECT ${monitorFields} FROM monitors m WHERE m.user_id=${userId} ORDER BY m.name,m.id LIMIT ${limit} OFFSET ${offset}`,
        ),
      );
    },
    async getMonitor(id: string): Promise<MonitorDto | null> {
      requireId(id);
      return first(
        monitors(
          await ownedRows(
            sql`SELECT ${monitorFields} FROM monitors m WHERE m.id=${id} AND m.user_id=${userId} LIMIT 1`,
          ),
        ),
      );
    },
    async listMonitorSummaries(): Promise<MonitorSummary[]> {
      const now = date(currentTime());
      const found = await loadMonitorHistory(now, MONITOR_RANGES["24h"].durationMs);
      return found.map((row) => {
        const history = monitorHistory(row);
        return {
          ...monitor(row, now),
          ...summarizeMonitor(history, now),
          openIncidentStartedAt: openIncidentStartedAt(history),
        };
      });
    },
    async getMonitorInsights(id: string, range: MonitorRange): Promise<MonitorDetail | null> {
      requireId(id);
      if (typeof range !== "string" || !Object.hasOwn(MONITOR_RANGES, range))
        throw new DataAccessError();
      const now = date(currentTime());
      // The daily bar always uses up to 30 days, regardless of the chart range.
      const row = first(await loadMonitorHistory(now, MONITOR_RANGES["30d"].durationMs, id));
      if (!row) return null;
      const history = monitorHistory(row);
      return {
        monitor: monitor(row, now),
        insights: buildMonitorInsights(history, range, now),
        openIncidentStartedAt: openIncidentStartedAt(history),
      };
    },
    async renameMonitor(id: string, name: string): Promise<boolean> {
      requireId(id);
      requireText(name);
      return changed(
        sql`UPDATE monitors SET name=${name} WHERE id=${id} AND user_id=${userId} RETURNING id`,
      );
    },
    async deleteMonitor(id: string): Promise<boolean> {
      requireId(id);
      return changed(sql`DELETE FROM monitors WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },

    async listChannels(page?: DataPage): Promise<ChannelDto[]> {
      const { limit, offset } = pageBounds(page);
      return (
        await ownedRows(
          sql`SELECT ${channelFields} FROM alert_channels c WHERE c.user_id=${userId} ORDER BY c.label,c.id LIMIT ${limit} OFFSET ${offset}`,
        )
      ).map(channel);
    },
    async getChannel(id: string): Promise<ChannelDto | null> {
      requireId(id);
      return first(
        (
          await ownedRows(
            sql`SELECT ${channelFields} FROM alert_channels c WHERE c.id=${id} AND c.user_id=${userId} LIMIT 1`,
          )
        ).map(channel),
      );
    },
    async renameChannel(id: string, label: string): Promise<boolean> {
      requireId(id);
      requireText(label);
      return changed(
        sql`UPDATE alert_channels SET label=${label} WHERE id=${id} AND user_id=${userId} RETURNING id`,
      );
    },
    async deleteChannel(id: string): Promise<boolean> {
      requireId(id);
      return changed(
        sql`DELETE FROM alert_channels WHERE id=${id} AND user_id=${userId} RETURNING id`,
      );
    },

    async getIncident(id: string): Promise<IncidentDto | null> {
      requireId(id);
      return first(
        (
          await ownedRows(
            sql`SELECT ${incidentFields} FROM incidents i INNER JOIN monitors m ON m.id=i.monitor_id AND m.user_id=i.user_id WHERE i.id=${id} AND i.user_id=${userId} AND m.user_id=${userId} LIMIT 1`,
          )
        ).map(incident),
      );
    },
    async listIncidents(monitorId: string, page?: DataPage): Promise<IncidentDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      return (
        await ownedRows(
          sql`SELECT ${incidentFields} FROM incidents i INNER JOIN monitors m ON m.id=i.monitor_id AND m.user_id=i.user_id WHERE i.monitor_id=${monitorId} AND i.user_id=${userId} AND m.user_id=${userId} ORDER BY i.started_at DESC,i.id DESC LIMIT ${limit} OFFSET ${offset}`,
        )
      ).map(incident);
    },
    async deleteIncident(id: string): Promise<boolean> {
      requireId(id);
      return changed(
        sql`DELETE FROM incidents i WHERE i.id=${id} AND i.user_id=${userId} AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=i.monitor_id AND m.user_id=${userId}) RETURNING i.id`,
      );
    },

    async listStatusPages(page?: DataPage): Promise<StatusPageDto[]> {
      const { limit, offset } = pageBounds(page);
      return (
        await ownedRows(
          sql`SELECT ${pageFields} FROM status_pages p WHERE p.user_id=${userId} ORDER BY p.slug,p.id LIMIT ${limit} OFFSET ${offset}`,
        )
      ).map(statusPage);
    },
    async getStatusPage(id: string): Promise<StatusPageDto | null> {
      requireId(id);
      return first(
        (
          await ownedRows(
            sql`SELECT ${pageFields} FROM status_pages p WHERE p.id=${id} AND p.user_id=${userId} LIMIT 1`,
          )
        ).map(statusPage),
      );
    },
    async renameStatusPage(id: string, title: string): Promise<boolean> {
      requireId(id);
      requireText(title);
      return changed(
        sql`UPDATE status_pages SET title=${title} WHERE id=${id} AND user_id=${userId} RETURNING id`,
      );
    },
    async deleteStatusPage(id: string): Promise<boolean> {
      requireId(id);
      return changed(
        sql`DELETE FROM status_pages WHERE id=${id} AND user_id=${userId} RETURNING id`,
      );
    },
    async setStatusPagePublished(id: string, isPublished: boolean): Promise<boolean> {
      requireId(id);
      if (typeof isPublished !== "boolean") throw new DataAccessError();
      return associationWrite(async (tx) => {
        if (!(await lockPage(tx, id))) return false;
        if (isPublished) {
          const links = await rows(
            tx,
            sql`SELECT monitor_id FROM status_page_monitors WHERE status_page_id=${id} AND user_id=${userId}`,
          );
          if (!links.length || links.length > maxPageMonitors) return false;
        }
        return (
          (
            await rows(
              tx,
              sql`UPDATE status_pages SET is_published=${isPublished} WHERE id=${id} AND user_id=${userId} RETURNING id`,
            )
          ).length === 1
        );
      });
    },

    async listChecks(monitorId: string, page?: DataPage): Promise<CheckDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      const found = await ownedRows(
        sql`SELECT c.id,c.monitor_id AS "monitorId",c.checked_at AS "checkedAt",c.ok,c.status_code AS "statusCode",c.response_ms AS "responseMs",c.error_type AS "errorType" FROM checks c INNER JOIN monitors m ON m.id=c.monitor_id WHERE c.monitor_id=${monitorId} AND m.user_id=${userId} ORDER BY c.checked_at DESC,c.id DESC LIMIT ${limit} OFFSET ${offset}`,
      );
      return found.map((row) => ({
        id: String(row.id),
        monitorId: String(row.monitorId),
        checkedAt: date(row.checkedAt),
        ok: row.ok as boolean,
        statusCode: row.statusCode as number | null,
        responseMs: row.responseMs as number | null,
        errorType: row.errorType as CheckDto["errorType"],
      }));
    },
    async listMonitorChannels(monitorId: string, page?: DataPage): Promise<ChannelDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      return (
        await ownedRows(
          sql`SELECT ${channelFields} FROM monitor_alert_channels l INNER JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id INNER JOIN alert_channels c ON c.id=l.channel_id AND c.user_id=l.user_id WHERE l.monitor_id=${monitorId} AND l.user_id=${userId} AND m.user_id=${userId} AND c.user_id=${userId} ORDER BY c.label,c.id LIMIT ${limit} OFFSET ${offset}`,
        )
      ).map(channel);
    },
    async attachMonitorChannel(monitorId: string, channelId: string): Promise<boolean> {
      requireId(monitorId);
      requireId(channelId);
      return associationWrite(async (tx) => {
        if (!(await lockMonitor(tx, monitorId))) return false;
        const channel = await rows(
          tx,
          sql`SELECT id FROM alert_channels WHERE id=${channelId} AND user_id=${userId} FOR KEY SHARE`,
        );
        if (!channel.length) return false;
        const existing = await rows(
          tx,
          sql`SELECT channel_id FROM monitor_alert_channels WHERE monitor_id=${monitorId} AND user_id=${userId}`,
        );
        if (existing.some((row) => row.channel_id === channelId.toLowerCase())) return true;
        if (existing.length >= maxMonitorChannels) throw new DataAccessError();
        await rows(
          tx,
          sql`INSERT INTO monitor_alert_channels (user_id,monitor_id,channel_id) VALUES (${userId},${monitorId},${channelId})`,
        );
        return true;
      });
    },
    async replaceMonitorChannels(
      monitorId: string,
      channelIds: readonly string[],
    ): Promise<boolean> {
      requireId(monitorId);
      ids(channelIds, maxMonitorChannels);
      return associationWrite(async (tx) => {
        if (!(await lockMonitor(tx, monitorId))) return false;
        if (channelIds.length) {
          const selected = await rows(
            tx,
            sql`SELECT id FROM alert_channels WHERE user_id=${userId} AND id IN (${sql.join(
              channelIds.map((id) => sql`${id}`),
              sql`,`,
            )}) FOR KEY SHARE`,
          );
          if (selected.length !== channelIds.length) return false;
        }
        await rows(
          tx,
          sql`DELETE FROM monitor_alert_channels WHERE monitor_id=${monitorId} AND user_id=${userId}`,
        );
        if (channelIds.length) {
          await rows(
            tx,
            sql`INSERT INTO monitor_alert_channels (user_id,monitor_id,channel_id) VALUES ${sql.join(
              channelIds.map((id) => sql`(${userId},${monitorId},${id})`),
              sql`,`,
            )}`,
          );
        }
        return true;
      });
    },
    async unlinkMonitorChannel(monitorId: string, channelId: string): Promise<boolean> {
      requireId(monitorId);
      requireId(channelId);
      return associationWrite(async (tx) => {
        if (!(await lockMonitor(tx, monitorId))) return false;
        return (
          (
            await rows(
              tx,
              sql`DELETE FROM monitor_alert_channels l WHERE l.monitor_id=${monitorId} AND l.channel_id=${channelId} AND l.user_id=${userId} AND EXISTS(SELECT 1 FROM alert_channels c WHERE c.id=l.channel_id AND c.user_id=${userId}) RETURNING l.monitor_id`,
            )
          ).length === 1
        );
      });
    },

    async listPageMonitors(pageId: string, page?: DataPage): Promise<PageMonitorDto[]> {
      requireId(pageId);
      const { limit, offset } = pageBounds(page);
      const found = await ownedRows(
        sql`SELECT m.id AS "monitorId",m.name,${monitorStateFields},l.position,l.show_url AS "showUrl" FROM status_page_monitors l INNER JOIN status_pages p ON p.id=l.status_page_id AND p.user_id=l.user_id INNER JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id WHERE l.status_page_id=${pageId} AND l.user_id=${userId} AND p.user_id=${userId} AND m.user_id=${userId} ORDER BY l.position,m.id LIMIT ${limit} OFFSET ${offset}`,
      );
      const now = date(currentTime());
      return found.map((row) => ({
        monitorId: String(row.monitorId),
        name: String(row.name),
        status: displayStatus(row, now),
        position: row.position as number,
        showUrl: row.showUrl as boolean,
      }));
    },
    async attachPageMonitor(pageId: string, monitorId: string): Promise<boolean> {
      requireId(pageId);
      requireId(monitorId);
      return associationWrite(async (tx) => {
        if (!(await lockPage(tx, pageId))) return false;
        if (
          !(
            await rows(
              tx,
              sql`SELECT id FROM monitors WHERE id=${monitorId} AND user_id=${userId} FOR KEY SHARE`,
            )
          ).length
        )
          return false;
        const existing = await rows(
          tx,
          sql`SELECT monitor_id,position FROM status_page_monitors WHERE status_page_id=${pageId} AND user_id=${userId}`,
        );
        if (existing.some((row) => row.monitor_id === monitorId.toLowerCase())) return true;
        if (existing.length >= maxPageMonitors) throw new DataAccessError();
        const position = existing.reduce(
          (maximum, row) => Math.max(maximum, Number(row.position) + 1),
          0,
        );
        await rows(
          tx,
          sql`INSERT INTO status_page_monitors (user_id,status_page_id,monitor_id,position) VALUES (${userId},${pageId},${monitorId},${position})`,
        );
        return true;
      });
    },
    async replacePageMonitors(pageId: string, monitorIds: readonly string[]): Promise<boolean> {
      requireId(pageId);
      ids(monitorIds, maxPageMonitors);
      return associationWrite(async (tx) => {
        if (!(await lockPage(tx, pageId))) return false;
        if (monitorIds.length) {
          const selected = await rows(
            tx,
            sql`SELECT id FROM monitors WHERE user_id=${userId} AND id IN (${sql.join(
              monitorIds.map((id) => sql`${id}`),
              sql`,`,
            )}) FOR KEY SHARE`,
          );
          if (selected.length !== monitorIds.length) return false;
        }
        const existing = await rows(
          tx,
          sql`SELECT monitor_id,show_url FROM status_page_monitors WHERE status_page_id=${pageId} AND user_id=${userId}`,
        );
        const visibility = new Map(existing.map((row) => [row.monitor_id, row.show_url === true]));
        await rows(
          tx,
          sql`DELETE FROM status_page_monitors WHERE status_page_id=${pageId} AND user_id=${userId}`,
        );
        if (monitorIds.length) {
          const values = monitorIds.map(
            (id, position) =>
              sql`(${userId},${pageId},${id},${position},${visibility.get(id.toLowerCase()) ?? false})`,
          );
          await rows(
            tx,
            sql`INSERT INTO status_page_monitors (user_id,status_page_id,monitor_id,position,show_url) VALUES ${sql.join(values, sql`,`)}`,
          );
        }
        return true;
      });
    },
    async setPageMonitorVisibility(
      pageId: string,
      monitorId: string,
      showUrl: boolean,
    ): Promise<boolean> {
      requireId(pageId);
      requireId(monitorId);
      if (typeof showUrl !== "boolean") throw new DataAccessError();
      return associationWrite(async (tx) => {
        if (!(await lockPage(tx, pageId))) return false;
        const owned = await rows(
          tx,
          sql`SELECT id FROM monitors WHERE id=${monitorId}
          AND user_id=${userId} FOR KEY SHARE`,
        );
        if (!owned.length) return false;
        return (
          (
            await rows(
              tx,
              sql`UPDATE status_page_monitors SET show_url=${showUrl}
          WHERE status_page_id=${pageId} AND monitor_id=${monitorId} AND user_id=${userId}
          RETURNING monitor_id`,
            )
          ).length === 1
        );
      });
    },
    async unlinkPageMonitor(pageId: string, monitorId: string): Promise<boolean> {
      requireId(pageId);
      requireId(monitorId);
      return associationWrite(async (tx) => {
        if (!(await lockPage(tx, pageId))) return false;
        return (
          (
            await rows(
              tx,
              sql`DELETE FROM status_page_monitors l WHERE l.status_page_id=${pageId} AND l.monitor_id=${monitorId} AND l.user_id=${userId} AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=l.monitor_id AND m.user_id=${userId}) RETURNING l.monitor_id`,
            )
          ).length === 1
        );
      });
    },

    async listAlertOutbox(incidentId: string, page?: DataPage): Promise<AlertOutboxDto[]> {
      requireId(incidentId);
      const { limit, offset } = pageBounds(page);
      const found = await ownedRows(
        sql`SELECT e.id,e.incident_id AS "incidentId",e.channel_id AS "channelId",e.kind,e.status,e.attempts,e.sent_at AS "sentAt" FROM alert_outbox e INNER JOIN incidents i ON i.id=e.incident_id AND i.user_id=e.user_id INNER JOIN monitors m ON m.id=i.monitor_id AND m.user_id=i.user_id INNER JOIN alert_channels c ON c.id=e.channel_id AND c.user_id=e.user_id WHERE e.incident_id=${incidentId} AND e.user_id=${userId} AND i.user_id=${userId} AND m.user_id=${userId} AND c.user_id=${userId} ORDER BY e.created_at DESC,e.id DESC LIMIT ${limit} OFFSET ${offset}`,
      );
      return found.map((row) => ({
        id: String(row.id),
        incidentId: String(row.incidentId),
        channelId: String(row.channelId),
        kind: row.kind as AlertOutboxDto["kind"],
        status: row.status as AlertOutboxDto["status"],
        attempts: row.attempts as number,
        sentAt: optionalDate(row.sentAt),
      }));
    },
  };
}

export type DataAccess = ReturnType<typeof createDataAccess>;
