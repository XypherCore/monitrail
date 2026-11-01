import { sql, type SQL } from "drizzle-orm";

/** Server-side database capability, supplied by the authenticated session wrapper. */
export type DataExecutor = { execute(statement: SQL): PromiseLike<{ rows: unknown[] }> };
export type DataPage = { limit?: number; offset?: number };
export type MonitorDto = {
  id: string; name: string; url: string; status: "pending" | "up" | "down" | "paused";
  isPaused: boolean; intervalSeconds: number; expectedStatus: string; lastCheckedAt: Date | null;
};
export type ChannelDto = {
  id: string; type: "telegram" | "webhook"; label: string; isVerified: boolean; createdAt: Date;
};
export type IncidentDto = {
  id: string; monitorId: string; startedAt: Date; resolvedAt: Date | null;
  cause: "dns" | "timeout" | "tls" | "connect" | "bad_status" | "blocked" | "other";
};
export type StatusPageDto = {
  id: string; slug: string; title: string; isPublished: boolean; createdAt: Date;
};
export type CheckDto = {
  id: string; monitorId: string; checkedAt: Date; ok: boolean;
  statusCode: number | null; responseMs: number | null; errorType: IncidentDto["cause"] | null;
};
export type RollupDto = {
  monitorId: string; hour: Date; total: number; failed: number;
  avgMs: number | null; p95Ms: number | null; maxMs: number | null;
};
export type PageMonitorDto = {
  monitorId: string; name: string; status: MonitorDto["status"]; position: number; showUrl: boolean;
};
export type AlertEventDto = {
  id: string; incidentId: string; channelId: string; kind: "down" | "up";
  success: boolean; sentAt: Date | null;
};

export class DataAccessError extends Error {
  constructor() {
    super("Data access failed.");
    this.name = "DataAccessError";
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function requireId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !uuid.test(value)) throw new DataAccessError();
}
function requireText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw new DataAccessError();
}
function pageBounds(page: DataPage = {}): { limit: number; offset: number } {
  // Bounded query pagination, not a product quota; callers can request subsequent pages.
  const limit = page.limit ?? 100;
  const offset = page.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new DataAccessError();
  }
  return { limit, offset };
}
function date(value: unknown): Date {
  if (!(value instanceof Date) && typeof value !== "string") throw new DataAccessError();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new DataAccessError();
  return parsed;
}
function optionalDate(value: unknown): Date | null { return value === null ? null : date(value); }
type Row = Record<string, unknown>;

const monitorFields = sql`m.id,m.name,m.url,m.status,m.is_paused AS "isPaused",m.interval_seconds AS "intervalSeconds",m.expected_status AS "expectedStatus",m.last_checked_at AS "lastCheckedAt"`;
const channelFields = sql`c.id,c.type,c.label,c.is_verified AS "isVerified",c.created_at AS "createdAt"`;
const incidentFields = sql`i.id,i.monitor_id AS "monitorId",i.started_at AS "startedAt",i.resolved_at AS "resolvedAt",i.cause`;
const pageFields = sql`p.id,p.slug,p.title,p.is_published AS "isPublished",p.created_at AS "createdAt"`;

function monitor(row: Row): MonitorDto {
  return { id: String(row.id), name: String(row.name), url: String(row.url), status: row.status as MonitorDto["status"], isPaused: row.isPaused as boolean, intervalSeconds: row.intervalSeconds as number, expectedStatus: String(row.expectedStatus), lastCheckedAt: optionalDate(row.lastCheckedAt) };
}
function channel(row: Row): ChannelDto {
  // Config ciphertext and provider/session credentials are never selected or returned.
  return { id: String(row.id), type: row.type as ChannelDto["type"], label: String(row.label), isVerified: row.isVerified as boolean, createdAt: date(row.createdAt) };
}
function incident(row: Row): IncidentDto {
  return { id: String(row.id), monitorId: String(row.monitorId), startedAt: date(row.startedAt), resolvedAt: optionalDate(row.resolvedAt), cause: row.cause as IncidentDto["cause"] };
}
function statusPage(row: Row): StatusPageDto {
  return { id: String(row.id), slug: String(row.slug), title: String(row.title), isPublished: row.isPublished as boolean, createdAt: date(row.createdAt) };
}

/**
 * Bind once to the authenticated session's UUID, never an identity from request input.
 * SQL and explicit safe DTOs stay here. No target URL writes/fetches or public CRUD
 * handlers are provided before their guard, quota and lifecycle phases exist.
 */
export function createDataAccess(db: DataExecutor, userId: string) {
  requireId(userId);
  const rows = async <T extends Row = Row>(statement: SQL): Promise<T[]> => {
    try {
      const result = await db.execute(statement);
      if (!Array.isArray(result.rows) || result.rows.some(row => typeof row !== "object" || row === null || Array.isArray(row))) {
        throw new DataAccessError();
      }
      // Statements and selected columns are fixed within this module, never caller supplied.
      return result.rows as T[];
    } catch {
      // A driver exception can include a database URL, values or credentials.
      throw new DataAccessError();
    }
  };
  const changed = async (statement: SQL) => (await rows(statement)).length === 1;
  const first = <T>(found: T[]) => found[0] ?? null;

  return {
    async listMonitors(page?: DataPage): Promise<MonitorDto[]> {
      const { limit, offset } = pageBounds(page);
      return (await rows(sql`SELECT ${monitorFields} FROM monitors m WHERE m.user_id=${userId} ORDER BY m.name,m.id LIMIT ${limit} OFFSET ${offset}`)).map(monitor);
    },
    async getMonitor(id: string): Promise<MonitorDto | null> {
      requireId(id);
      return first((await rows(sql`SELECT ${monitorFields} FROM monitors m WHERE m.id=${id} AND m.user_id=${userId} LIMIT 1`)).map(monitor));
    },
    async renameMonitor(id: string, name: string): Promise<boolean> {
      requireId(id); requireText(name);
      return changed(sql`UPDATE monitors SET name=${name} WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },
    async deleteMonitor(id: string): Promise<boolean> {
      requireId(id);
      return changed(sql`DELETE FROM monitors WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },

    async listChannels(page?: DataPage): Promise<ChannelDto[]> {
      const { limit, offset } = pageBounds(page);
      return (await rows(sql`SELECT ${channelFields} FROM alert_channels c WHERE c.user_id=${userId} ORDER BY c.label,c.id LIMIT ${limit} OFFSET ${offset}`)).map(channel);
    },
    async getChannel(id: string): Promise<ChannelDto | null> {
      requireId(id);
      return first((await rows(sql`SELECT ${channelFields} FROM alert_channels c WHERE c.id=${id} AND c.user_id=${userId} LIMIT 1`)).map(channel));
    },
    async renameChannel(id: string, label: string): Promise<boolean> {
      requireId(id); requireText(label);
      return changed(sql`UPDATE alert_channels SET label=${label} WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },
    async deleteChannel(id: string): Promise<boolean> {
      requireId(id);
      return changed(sql`DELETE FROM alert_channels WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },

    async getIncident(id: string): Promise<IncidentDto | null> {
      requireId(id);
      return first((await rows(sql`SELECT ${incidentFields} FROM incidents i INNER JOIN monitors m ON m.id=i.monitor_id AND m.user_id=i.user_id WHERE i.id=${id} AND i.user_id=${userId} AND m.user_id=${userId} LIMIT 1`)).map(incident));
    },
    async listIncidents(monitorId: string, page?: DataPage): Promise<IncidentDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      return (await rows(sql`SELECT ${incidentFields} FROM incidents i INNER JOIN monitors m ON m.id=i.monitor_id AND m.user_id=i.user_id WHERE i.monitor_id=${monitorId} AND i.user_id=${userId} AND m.user_id=${userId} ORDER BY i.started_at DESC,i.id DESC LIMIT ${limit} OFFSET ${offset}`)).map(incident);
    },
    // Internal persistence primitive only; the incident state machine is Phase 5.
    async resolveIncident(id: string, resolvedAt: Date): Promise<boolean> {
      requireId(id);
      const resolved = date(resolvedAt);
      return changed(sql`UPDATE incidents i SET resolved_at=${resolved} WHERE i.id=${id} AND i.user_id=${userId} AND i.resolved_at IS NULL AND i.started_at<=${resolved} AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=i.monitor_id AND m.user_id=${userId}) RETURNING i.id`);
    },
    async deleteIncident(id: string): Promise<boolean> {
      requireId(id);
      return changed(sql`DELETE FROM incidents i WHERE i.id=${id} AND i.user_id=${userId} AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=i.monitor_id AND m.user_id=${userId}) RETURNING i.id`);
    },

    async listStatusPages(page?: DataPage): Promise<StatusPageDto[]> {
      const { limit, offset } = pageBounds(page);
      return (await rows(sql`SELECT ${pageFields} FROM status_pages p WHERE p.user_id=${userId} ORDER BY p.slug,p.id LIMIT ${limit} OFFSET ${offset}`)).map(statusPage);
    },
    async getStatusPage(id: string): Promise<StatusPageDto | null> {
      requireId(id);
      return first((await rows(sql`SELECT ${pageFields} FROM status_pages p WHERE p.id=${id} AND p.user_id=${userId} LIMIT 1`)).map(statusPage));
    },
    async renameStatusPage(id: string, title: string): Promise<boolean> {
      requireId(id); requireText(title);
      return changed(sql`UPDATE status_pages SET title=${title} WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },
    async deleteStatusPage(id: string): Promise<boolean> {
      requireId(id);
      return changed(sql`DELETE FROM status_pages WHERE id=${id} AND user_id=${userId} RETURNING id`);
    },

    async listChecks(monitorId: string, page?: DataPage): Promise<CheckDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      const found = await rows(sql`SELECT c.id,c.monitor_id AS "monitorId",c.checked_at AS "checkedAt",c.ok,c.status_code AS "statusCode",c.response_ms AS "responseMs",c.error_type AS "errorType" FROM checks c INNER JOIN monitors m ON m.id=c.monitor_id WHERE c.monitor_id=${monitorId} AND m.user_id=${userId} ORDER BY c.checked_at DESC,c.id DESC LIMIT ${limit} OFFSET ${offset}`);
      return found.map(row => ({ id: String(row.id), monitorId: String(row.monitorId), checkedAt: date(row.checkedAt), ok: row.ok as boolean, statusCode: row.statusCode as number | null, responseMs: row.responseMs as number | null, errorType: row.errorType as CheckDto["errorType"] }));
    },
    async listRollups(monitorId: string, page?: DataPage): Promise<RollupDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      const found = await rows(sql`SELECT r.monitor_id AS "monitorId",r.hour,r.total,r.failed,r.avg_ms AS "avgMs",r.p95_ms AS "p95Ms",r.max_ms AS "maxMs" FROM check_rollups_hourly r INNER JOIN monitors m ON m.id=r.monitor_id WHERE r.monitor_id=${monitorId} AND m.user_id=${userId} ORDER BY r.hour DESC LIMIT ${limit} OFFSET ${offset}`);
      return found.map(row => ({ monitorId: String(row.monitorId), hour: date(row.hour), total: row.total as number, failed: row.failed as number, avgMs: row.avgMs as number | null, p95Ms: row.p95Ms as number | null, maxMs: row.maxMs as number | null }));
    },
    async listMonitorChannels(monitorId: string, page?: DataPage): Promise<ChannelDto[]> {
      requireId(monitorId);
      const { limit, offset } = pageBounds(page);
      return (await rows(sql`SELECT ${channelFields} FROM monitor_alert_channels l INNER JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id INNER JOIN alert_channels c ON c.id=l.channel_id AND c.user_id=l.user_id WHERE l.monitor_id=${monitorId} AND l.user_id=${userId} AND m.user_id=${userId} AND c.user_id=${userId} ORDER BY c.label,c.id LIMIT ${limit} OFFSET ${offset}`)).map(channel);
    },
    async unlinkMonitorChannel(monitorId: string, channelId: string): Promise<boolean> {
      requireId(monitorId); requireId(channelId);
      return changed(sql`DELETE FROM monitor_alert_channels l WHERE l.monitor_id=${monitorId} AND l.channel_id=${channelId} AND l.user_id=${userId} AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=l.monitor_id AND m.user_id=${userId}) AND EXISTS(SELECT 1 FROM alert_channels c WHERE c.id=l.channel_id AND c.user_id=${userId}) RETURNING l.monitor_id`);
    },
    async listPageMonitors(pageId: string, page?: DataPage): Promise<PageMonitorDto[]> {
      requireId(pageId);
      const { limit, offset } = pageBounds(page);
      const found = await rows(sql`SELECT m.id AS "monitorId",m.name,m.status,l.position,l.show_url AS "showUrl" FROM status_page_monitors l INNER JOIN status_pages p ON p.id=l.status_page_id AND p.user_id=l.user_id INNER JOIN monitors m ON m.id=l.monitor_id AND m.user_id=l.user_id WHERE l.status_page_id=${pageId} AND l.user_id=${userId} AND p.user_id=${userId} AND m.user_id=${userId} ORDER BY l.position,m.id LIMIT ${limit} OFFSET ${offset}`);
      return found.map(row => ({ monitorId: String(row.monitorId), name: String(row.name), status: row.status as MonitorDto["status"], position: row.position as number, showUrl: row.showUrl as boolean }));
    },
    async setPageMonitorVisibility(pageId: string, monitorId: string, showUrl: boolean): Promise<boolean> {
      requireId(pageId); requireId(monitorId);
      if (typeof showUrl !== "boolean") throw new DataAccessError();
      return changed(sql`UPDATE status_page_monitors l SET show_url=${showUrl} WHERE l.status_page_id=${pageId} AND l.monitor_id=${monitorId} AND l.user_id=${userId} AND EXISTS(SELECT 1 FROM status_pages p WHERE p.id=l.status_page_id AND p.user_id=${userId}) AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=l.monitor_id AND m.user_id=${userId}) RETURNING l.monitor_id`);
    },
    async unlinkPageMonitor(pageId: string, monitorId: string): Promise<boolean> {
      requireId(pageId); requireId(monitorId);
      return changed(sql`DELETE FROM status_page_monitors l WHERE l.status_page_id=${pageId} AND l.monitor_id=${monitorId} AND l.user_id=${userId} AND EXISTS(SELECT 1 FROM status_pages p WHERE p.id=l.status_page_id AND p.user_id=${userId}) AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=l.monitor_id AND m.user_id=${userId}) RETURNING l.monitor_id`);
    },
    async listAlertEvents(incidentId: string, page?: DataPage): Promise<AlertEventDto[]> {
      requireId(incidentId);
      const { limit, offset } = pageBounds(page);
      const found = await rows(sql`SELECT e.id,e.incident_id AS "incidentId",e.channel_id AS "channelId",e.kind,e.success,e.sent_at AS "sentAt" FROM alert_events e INNER JOIN incidents i ON i.id=e.incident_id AND i.user_id=e.user_id INNER JOIN monitors m ON m.id=i.monitor_id AND m.user_id=i.user_id INNER JOIN alert_channels c ON c.id=e.channel_id AND c.user_id=e.user_id WHERE e.incident_id=${incidentId} AND e.user_id=${userId} AND i.user_id=${userId} AND m.user_id=${userId} AND c.user_id=${userId} ORDER BY e.sent_at DESC NULLS LAST,e.id DESC LIMIT ${limit} OFFSET ${offset}`);
      return found.map(row => ({ id: String(row.id), incidentId: String(row.incidentId), channelId: String(row.channelId), kind: row.kind as AlertEventDto["kind"], success: row.success as boolean, sentAt: optionalDate(row.sentAt) }));
    },
  };
}

export type DataAccess = ReturnType<typeof createDataAccess>;
