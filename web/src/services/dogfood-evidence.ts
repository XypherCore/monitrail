import { sql, type SQL } from "drizzle-orm";
import type { DataExecutor, IncidentDto } from "../data/access.ts";
import { isMonitorId } from "../monitors/input.ts";

export type DogfoodEvidenceInput = { monitorIds: string[]; from: string; to: string };
type EventKind = "created" | "paused" | "resumed" | "config_changed" | "blocked";
type ErrorCategory = IncidentDto["cause"];
type Resolution = IncidentDto["resolvedReason"];
export type DogfoodEvidence = {
  version: 1;
  from: string;
  to: string;
  capturedAt: string;
  missingAcceptanceEvidence: number;
  monitors: { id: string; configRev: number; intervalSeconds: number; isPaused: boolean; createdAt: string }[];
  checks: {
    attemptId: string; monitorId: string; configRev: number; checkedAt: string; acceptedAt: string | null;
    ok: boolean; statusCode: number | null; responseMs: number | null; errorType: ErrorCategory | null; redirectCount: number;
  }[];
  events: { id: string; monitorId: string; kind: EventKind; at: string }[];
  incidents: {
    id: string; monitorId: string; startedAt: string; confirmedAt: string;
    resolvedAt: string | null; resolvedConfirmedAt: string | null; resolvedReason: Resolution; cause: ErrorCategory;
  }[];
};

const errorCategories = new Set(["dns", "timeout", "tls", "connect", "bad_status", "blocked", "other"]);
const resolutions = new Set(["recovered", "paused", "config_changed", "blocked"]);
const eventKinds = new Set(["created", "paused", "resumed", "config_changed", "blocked"]);
const intervals = new Set([300, 600, 900, 1800, 3600]);

function timestamp(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) throw new Error();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error();
  return date.toISOString();
}

function utcInput(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) throw new Error();
  const result = timestamp(value);
  if (result !== value && result.replace(".000Z", "Z") !== value) throw new Error();
  return result;
}

/** Bounds the administrative query, without assigning metric or slot semantics. */
export function validateDogfoodEvidenceInput(value: unknown): DogfoodEvidenceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "from,monitorIds,to" || !Array.isArray(input.monitorIds)) throw new Error();
  if (input.monitorIds.length < 1 || input.monitorIds.length > 3 || input.monitorIds.some(id => !isMonitorId(id))) throw new Error();
  const monitorIds = input.monitorIds.map(id => (id as string).toLowerCase());
  if (new Set(monitorIds).size !== monitorIds.length) throw new Error();
  const from = utcInput(input.from);
  const to = utcInput(input.to);
  const duration = Date.parse(to) - Date.parse(from);
  if (duration <= 0 || duration > 14 * 24 * 60 * 60 * 1000) throw new Error();
  return { monitorIds, from, to };
}

function uuid(value: unknown): string {
  if (!isMonitorId(value)) throw new Error();
  return (value as string).toLowerCase();
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error();
  return value;
}

function category(value: unknown): ErrorCategory {
  if (typeof value !== "string" || !errorCategories.has(value)) throw new Error();
  return value as ErrorCategory;
}

function resolution(value: unknown): Resolution {
  if (value === null) return null;
  if (typeof value !== "string" || !resolutions.has(value)) throw new Error();
  return value as Resolution;
}

async function rows(tx: DataExecutor, statement: SQL): Promise<Record<string, unknown>[]> {
  return (await tx.execute(statement)).rows as Record<string, unknown>[];
}

/** Read-only projection for operator tools and the separately signed, scoped proof endpoint. */
export function createDogfoodEvidenceCapability(db: DataExecutor) {
  return {
    async exportDogfoodEvidence(value: unknown): Promise<DogfoodEvidence> {
      try {
        const input = validateDogfoodEvidenceInput(value);
        if (!db.transaction) throw new Error();
        return await db.transaction(async (tx) => {
          await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
          await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
          await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
          const [clock] = await rows(tx, sql`SELECT transaction_timestamp()::text AS at`);
          const capturedAt = timestamp(clock?.at);
          if (Date.parse(input.to) > Date.parse(capturedAt)) throw new Error();
          const selected = sql`SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(input.monitorIds)}::jsonb)`;
          const monitorRows = await rows(tx, sql`
            SELECT id,config_rev AS "configRev",interval_seconds AS "intervalSeconds",is_paused AS "isPaused",created_at AS "createdAt"
            FROM monitors WHERE id IN (${selected}) ORDER BY id
          `);
          if (monitorRows.length !== input.monitorIds.length) throw new Error();
          const monitors = monitorRows.map(row => {
            const intervalSeconds = integer(row.intervalSeconds, 1);
            if (!intervals.has(intervalSeconds)) throw new Error();
            return { id: uuid(row.id), configRev: integer(row.configRev, 1), intervalSeconds,
              isPaused: boolean(row.isPaused), createdAt: timestamp(row.createdAt) };
          });
          const checkRows = await rows(tx, sql`
            SELECT c.attempt_id AS "attemptId",c.monitor_id AS "monitorId",c.config_rev AS "configRev",
              c.checked_at AS "checkedAt",a.terminal_at AS "acceptedAt",c.ok,c.status_code AS "statusCode",
              c.response_ms AS "responseMs",c.error_type AS "errorType",c.redirect_count AS "redirectCount"
            FROM checks c LEFT JOIN check_attempts a ON a.attempt_id=c.attempt_id AND a.monitor_id=c.monitor_id
              AND a.config_rev=c.config_rev AND a.state='done' AND a.terminal_at<=${capturedAt}::timestamptz
            WHERE c.monitor_id IN (${selected}) AND (
              (c.checked_at>=${input.from}::timestamptz AND c.checked_at<${input.to}::timestamptz) OR
              (a.terminal_at>=${input.from}::timestamptz AND a.terminal_at<${input.to}::timestamptz))
            ORDER BY c.checked_at,c.attempt_id
          `);
          const checks = checkRows.map(row => ({
            attemptId: uuid(row.attemptId), monitorId: uuid(row.monitorId), configRev: integer(row.configRev, 1),
            checkedAt: timestamp(row.checkedAt), acceptedAt: row.acceptedAt === null ? null : timestamp(row.acceptedAt),
            ok: boolean(row.ok), statusCode: row.statusCode === null ? null : integer(row.statusCode, 100, 599),
            responseMs: row.responseMs === null ? null : integer(row.responseMs, 0),
            errorType: row.errorType === null ? null : category(row.errorType), redirectCount: integer(row.redirectCount, 0, 2),
          }));
          const eventRows = await rows(tx, sql`
            WITH boundary AS (
              SELECT DISTINCT ON (monitor_id) id,monitor_id,kind,at FROM monitor_events
              WHERE monitor_id IN (${selected}) AND at<${input.from}::timestamptz AND kind IN ('created','paused','resumed','blocked')
              ORDER BY monitor_id,at DESC,id DESC
            ), ranged AS (
              SELECT id,monitor_id,kind,at FROM monitor_events WHERE monitor_id IN (${selected})
                AND at>=${input.from}::timestamptz AND at<${input.to}::timestamptz
            )
            SELECT id,monitor_id AS "monitorId",kind,at FROM (SELECT * FROM boundary UNION ALL SELECT * FROM ranged) events ORDER BY at,id
          `);
          const events = eventRows.map(row => {
            if (typeof row.kind !== "string" || !eventKinds.has(row.kind)) throw new Error();
            return { id: uuid(row.id), monitorId: uuid(row.monitorId), kind: row.kind as EventKind, at: timestamp(row.at) };
          });
          const incidentRows = await rows(tx, sql`
            SELECT id,monitor_id AS "monitorId",started_at AS "startedAt",confirmed_at AS "confirmedAt",
              resolved_at AS "resolvedAt",resolved_confirmed_at AS "resolvedConfirmedAt",resolved_reason AS "resolvedReason",cause
            FROM incidents WHERE monitor_id IN (${selected}) AND started_at<${input.to}::timestamptz
              AND (resolved_at IS NULL OR resolved_at>=${input.from}::timestamptz)
            ORDER BY started_at,id
          `);
          const incidents = incidentRows.map(row => ({
            id: uuid(row.id), monitorId: uuid(row.monitorId), startedAt: timestamp(row.startedAt), confirmedAt: timestamp(row.confirmedAt),
            resolvedAt: row.resolvedAt === null ? null : timestamp(row.resolvedAt),
            resolvedConfirmedAt: row.resolvedConfirmedAt === null ? null : timestamp(row.resolvedConfirmedAt),
            resolvedReason: resolution(row.resolvedReason), cause: category(row.cause),
          }));
          return { version: 1, from: input.from, to: input.to, capturedAt,
            missingAcceptanceEvidence: checks.filter(check => check.acceptedAt === null).length,
            monitors, checks, events, incidents };
        });
      } catch {
        throw new Error("Dogfood evidence could not be exported.");
      }
    },
  };
}
