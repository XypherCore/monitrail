import { sql, type SQL } from "drizzle-orm";
import type { AlertErrorCategory, AlertResult, AlertSender, ChannelType } from "../alerts/contracts.ts";
import type { DataExecutor } from "../data/access.ts";
import type { OutboxCapability } from "./capabilities.ts";

const batchSize = 12;
const sendConcurrency = 4;
// Three waves of five-second transports fit inside a delivery lease.
const leaseSeconds = 30;
const maxAttempts = 6;
const firstRetryMinutes = 11;
const deadlineHours = 6;
const categories = new Set<AlertErrorCategory>([
  "blocked", "dns", "timeout", "connect", "tls", "bad_status", "other",
]);

type ClaimedDelivery = {
  id: string;
  userId: string;
  channelId: string;
  kind: "down" | "up";
  type: ChannelType;
  attempts: number;
  configEnc: string;
  payload: unknown;
  deadline: string;
};

type DeliveryOutcome = "sent" | "retrying" | "failed";

const downJoin = sql`
  LEFT JOIN alert_outbox d ON e.kind='up' AND d.user_id=e.user_id
    AND d.dedupe_key=e.incident_id::text || ':' || e.channel_id::text || ':down'
`;
const channelJoin = sql`
  JOIN alert_channels c ON c.id=e.channel_id AND c.user_id=e.user_id
`;
const deadline = sql`
  (CASE WHEN e.kind='down' THEN e.created_at ELSE greatest(e.created_at,d.sent_at) END)
    + ${deadlineHours}::double precision * interval '1 hour'
`;
const availableLease = sql`
  (e.status='pending' OR (e.status='sending' AND coalesce(e.claimed_until<=stamp.at,true)))
`;

async function rows<Row>(db: DataExecutor, statement: SQL): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

async function retireUnsendable(db: DataExecutor): Promise<number> {
  const retired = await rows(db, sql`
    WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at), terminal AS (
      SELECT e.id,c.is_verified
      FROM alert_outbox e ${channelJoin} ${downJoin} CROSS JOIN stamp
      WHERE ${availableLease} AND (
        NOT c.is_verified OR e.attempts>=${maxAttempts} OR
        (e.kind='up' AND (
          d.id IS NULL OR d.status='failed' OR (d.status='sent' AND d.sent_at IS NULL)
        )) OR
        ((e.kind='down' OR d.status='sent') AND ${deadline}<=stamp.at)
      )
      ORDER BY e.next_attempt_at,e.id
      LIMIT ${batchSize}
      FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE alert_outbox e SET status='failed',claimed_until=NULL,
      last_error_category=CASE WHEN NOT terminal.is_verified THEN 'blocked'::check_error
        ELSE coalesce(e.last_error_category,'other') END
    FROM terminal WHERE e.id=terminal.id RETURNING e.id
  `);
  return retired.length;
}

function claim(db: DataExecutor): Promise<ClaimedDelivery[]> {
  return rows(db, sql`
    WITH stamp AS MATERIALIZED (SELECT clock_timestamp() AS at), due AS (
      SELECT e.id,c.type,c.config_enc,stamp.at,${deadline} AS deadline
      FROM alert_outbox e ${channelJoin} ${downJoin} CROSS JOIN stamp
      WHERE ${availableLease} AND c.is_verified AND e.attempts<${maxAttempts}
        AND (e.kind='down' OR (d.status='sent' AND d.sent_at IS NOT NULL))
        AND ${deadline}>stamp.at AND e.next_attempt_at<=stamp.at
      ORDER BY e.next_attempt_at,e.id
      LIMIT ${batchSize}
      FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE alert_outbox e SET status='sending',attempts=e.attempts+1,
      claimed_until=due.at+${leaseSeconds}::double precision * interval '1 second',
      next_attempt_at=due.at+${firstRetryMinutes}::double precision * power(2.0,e.attempts)
        * interval '1 minute'
    FROM due WHERE e.id=due.id
    RETURNING e.id,e.user_id AS "userId",e.channel_id AS "channelId",e.kind,e.attempts,e.payload,
      due.type,due.config_enc AS "configEnc",due.deadline::text AS deadline
  `);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function payloadFor(delivery: ClaimedDelivery) {
  const payload = record(delivery.payload);
  const monitor = record(payload?.monitor);
  const incident = record(payload?.incident);
  const event = delivery.kind === "down" ? "incident.opened" : "incident.resolved";
  const startedAt = timestamp(incident?.started_at);
  const confirmedAt = timestamp(incident?.confirmed_at);
  const resolvedAt = timestamp(incident?.resolved_at);
  const cause = incident?.cause;
  if (
    payload?.version !== 1 || payload.event !== event || payload.event_id !== delivery.id ||
    typeof monitor?.name !== "string" || !startedAt || !confirmedAt ||
    (delivery.kind === "down" ? incident?.resolved_at !== null : !resolvedAt) ||
    typeof cause !== "string" || !categories.has(cause as AlertErrorCategory)
  ) return null;
  // Reconstruct the documented shape. Extraneous database fields never go to recipients.
  return {
    version: 1,
    event,
    event_id: delivery.id,
    monitor: { name: monitor.name },
    incident: { started_at: startedAt, confirmed_at: confirmedAt, resolved_at: resolvedAt, cause },
    sent_at: new Date().toISOString(),
  };
}

async function settle(
  db: DataExecutor,
  delivery: ClaimedDelivery,
  result: AlertResult,
  invalidPayload: boolean,
): Promise<DeliveryOutcome | null> {
  // A reclaimed attempt increments the fence. A late sender cannot overwrite it.
  const owned = sql`id=${delivery.id} AND status='sending' AND attempts=${delivery.attempts}`;
  if (result.ok) {
    const [changed] = await rows(db, sql`
      UPDATE alert_outbox SET status='sent',sent_at=clock_timestamp(),claimed_until=NULL,
        last_error_category=NULL WHERE ${owned} RETURNING id
    `);
    return changed ? "sent" : null;
  }
  const category = categories.has(result.category) ? result.category : "other";
  const retryMinutes = firstRetryMinutes * 2 ** (delivery.attempts - 1);
  const [changed] = await rows<{ status: "pending" | "failed" }>(db, sql`
    WITH next AS (
      SELECT clock_timestamp()+${retryMinutes}::double precision * interval '1 minute' AS at
    )
    UPDATE alert_outbox SET claimed_until=NULL,last_error_category=${category}::check_error,
      next_attempt_at=next.at,
      status=CASE WHEN ${invalidPayload} OR attempts>=${maxAttempts} OR next.at>=${delivery.deadline}::timestamptz
        THEN 'failed' ELSE 'pending' END
    FROM next WHERE ${owned} RETURNING status
  `);
  return changed ? changed.status === "pending" ? "retrying" : "failed" : null;
}

async function deliver(db: DataExecutor, send: AlertSender, delivery: ClaimedDelivery) {
  const payload = payloadFor(delivery);
  let result: AlertResult = { ok: false, category: "other" };
  if (payload) {
    try {
      result = await send({
        id: delivery.channelId,
        userId: delivery.userId,
        type: delivery.type,
        configEnc: delivery.configEnc,
        payload,
      });
    } catch {
      // Exceptions from adapters or providers may contain credentials or private URLs.
    }
  }
  return settle(db, delivery, result, payload === null);
}

export function createOutboxCapability(db: DataExecutor, send: AlertSender): OutboxCapability {
  return {
    async deliverOutbox() {
      const totals = { sent: 0, retrying: 0, failed: await retireUnsendable(db) };
      const deliveries = await claim(db);
      // The database has released its row locks before any transport starts.
      for (let offset = 0; offset < deliveries.length; offset += sendConcurrency) {
        const wave = deliveries.slice(offset, offset + sendConcurrency);
        for (const outcome of await Promise.allSettled(wave.map(row => deliver(db, send, row)))) {
          // A failed settlement leaves the durable lease and retry time intact.
          if (outcome.status === "rejected") totals.retrying += 1;
          else if (outcome.value) totals[outcome.value] += 1;
        }
      }
      return totals;
    },
  };
}
