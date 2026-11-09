import { sql, type SQL } from "drizzle-orm";
import type { CheckOutcome } from "../../../shared/checks/protocol.ts";
import { INTERNAL_CLOCK_SKEW_SECONDS } from "../../../shared/checks/signing.ts";
import type { DataExecutor } from "../data/access.ts";
import type { AttemptResult, CheckCapabilities } from "./capabilities.ts";
import { advanceCheck, classifyCheck, type MonitorCheckState } from "./check-state.ts";

type MonitorRow = MonitorCheckState & {
  userId: string;
  name: string;
  configRev: number;
  intervalSeconds: number;
  isPaused: boolean;
  leaseId: string | null;
  leaseUntil: string | null;
  lastCheckedAt: string | null;
};
type AttemptRow = {
  state: "claimed" | "done" | "dropped" | "expired";
  configRev: number;
  expectedStatus: "2xx" | "2xx_3xx";
  acceptedAt: string;
  checkedAt: string;
  attemptExpired: boolean;
  leaseExpired: boolean;
  timeValid: boolean;
  isNewer: boolean;
};

async function rows<Row>(db: DataExecutor, query: SQL): Promise<Row[]> {
  return (await db.execute(query)).rows as Row[];
}

async function lockMonitor(tx: DataExecutor, monitorId: string) {
  const [monitor] = await rows<MonitorRow>(tx, sql`
    SELECT user_id AS "userId",name,status,config_rev AS "configRev",
      interval_seconds AS "intervalSeconds",is_paused AS "isPaused",
      lease_id AS "leaseId",lease_until::text AS "leaseUntil",
      last_checked_at::text AS "lastCheckedAt",failures,successes,
      streak_started_at::text AS "streakStartedAt",streak_first_error AS "streakFirstError"
    FROM monitors WHERE id=${monitorId} FOR UPDATE
  `);
  return monitor;
}

async function lockAttempt(tx: DataExecutor, result: AttemptResult, monitor: MonitorRow) {
  const startedAt = result.startedAt.toISOString();
  const [attempt] = await rows<AttemptRow>(tx, sql`
    WITH locked AS MATERIALIZED (
      SELECT state,config_rev,expected_status,claimed_at,expires_at
      FROM check_attempts WHERE attempt_id=${result.attemptId} AND monitor_id=${result.monitorId}
      FOR UPDATE
    ), receipt AS MATERIALIZED (
      SELECT *,clock_timestamp() AS accepted_at FROM locked
    ), observation AS (
      SELECT *,greatest(claimed_at,least(accepted_at,${startedAt}::timestamptz)) AS checked_at
      FROM receipt
    )
    SELECT state,config_rev AS "configRev",expected_status AS "expectedStatus",
      accepted_at::text AS "acceptedAt",checked_at::text AS "checkedAt",
      accepted_at >= expires_at AS "attemptExpired",
      coalesce(accepted_at >= ${monitor.leaseUntil}::timestamptz,true) AS "leaseExpired",
      (accepted_at >= claimed_at AND ${startedAt}::timestamptz BETWEEN
        claimed_at - ${INTERNAL_CLOCK_SKEW_SECONDS}::double precision * interval '1 second'
        AND accepted_at + ${INTERNAL_CLOCK_SKEW_SECONDS}::double precision * interval '1 second')
        AS "timeValid",
      coalesce(checked_at > ${monitor.lastCheckedAt}::timestamptz,true) AS "isNewer"
    FROM observation
  `);
  return attempt;
}

async function finishAttempt(
  tx: DataExecutor,
  result: AttemptResult,
  state: Exclude<AttemptRow["state"], "claimed">,
  acceptedAt: string,
) {
  await tx.execute(sql`
    UPDATE check_attempts SET state=${state},terminal_at=greatest(${acceptedAt}::timestamptz,claimed_at)
    WHERE attempt_id=${result.attemptId} AND monitor_id=${result.monitorId} AND state='claimed'
  `);
}

async function enqueueIncidentAlert(
  tx: DataExecutor,
  monitor: MonitorRow,
  monitorId: string,
  incidentId: string,
  kind: "down" | "up",
  acceptedAt: string,
) {
  const event = kind === "down" ? "incident.opened" : "incident.resolved";
  // A pending payload carries the stable delivery ID. Delivery supplies sent_at.
  // Phase 7 must defer recovery delivery until the corresponding down is sent.
  await tx.execute(sql`
    WITH recipients AS MATERIALIZED (
      SELECT gen_random_uuid() AS event_id,c.id AS channel_id
      FROM monitor_alert_channels s
      JOIN alert_channels c ON c.id=s.channel_id AND c.user_id=s.user_id
      WHERE s.monitor_id=${monitorId} AND s.user_id=${monitor.userId} AND c.is_verified
        AND (${kind}::alert_kind='down' OR EXISTS (
          SELECT 1 FROM alert_outbox previous
          WHERE previous.incident_id=${incidentId} AND previous.channel_id=c.id
            AND previous.user_id=s.user_id AND previous.kind='down'
            AND previous.status IN ('pending','sending','sent')
        ))
      FOR KEY SHARE OF c
    )
    INSERT INTO alert_outbox(id,incident_id,channel_id,user_id,kind,dedupe_key,payload,
      created_at,next_attempt_at)
    SELECT r.event_id,i.id,r.channel_id,i.user_id,${kind}::alert_kind,
      i.id::text || ':' || r.channel_id::text || ':' || ${kind}::text,
      jsonb_build_object('version',1,'event',${event}::text,'event_id',r.event_id,
        'monitor',jsonb_build_object('name',${monitor.name}::text),
        'incident',jsonb_build_object('started_at',i.started_at,'confirmed_at',i.confirmed_at,
          'resolved_at',i.resolved_at,'cause',i.cause),'sent_at',NULL),
      ${acceptedAt}::timestamptz,${acceptedAt}::timestamptz
    FROM recipients r CROSS JOIN incidents i
    WHERE i.id=${incidentId} AND i.monitor_id=${monitorId} AND i.user_id=${monitor.userId}
    ON CONFLICT (dedupe_key) DO NOTHING
  `);
}

async function persistIncident(
  tx: DataExecutor,
  monitor: MonitorRow,
  monitorId: string,
  transition: NonNullable<ReturnType<typeof advanceCheck>["incident"]>,
  acceptedAt: string,
) {
  const observedAt = transition.observedAt;
  const [incident] = transition.kind === "down"
    ? await rows<{ id: string }>(tx, sql`
        INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause,created_at)
        VALUES (${monitorId},${monitor.userId},${observedAt}::timestamptz,
          ${acceptedAt}::timestamptz,${transition.cause},${acceptedAt}::timestamptz)
        RETURNING id
      `)
    : await rows<{ id: string }>(tx, sql`
        UPDATE incidents SET resolved_at=${observedAt}::timestamptz,
          resolved_confirmed_at=${acceptedAt}::timestamptz,resolved_reason='recovered'
        WHERE monitor_id=${monitorId} AND user_id=${monitor.userId} AND resolved_at IS NULL
        RETURNING id
      `);
  if (!incident) throw new Error("Incident transition did not complete.");
  await enqueueIncidentAlert(tx, monitor, monitorId, incident.id, transition.kind, acceptedAt);
}

async function ingestOne(tx: DataExecutor, result: AttemptResult): Promise<CheckOutcome> {
  // Claim, lifecycle edits and ingest serialize on the monitor row first.
  const monitor = await lockMonitor(tx, result.monitorId);
  if (!monitor) return "dropped";
  const attempt = await lockAttempt(tx, result, monitor);
  if (attempt?.state !== "claimed") return "dropped";

  const heldLease = monitor.leaseId === result.attemptId;
  if (attempt.attemptExpired || (heldLease && attempt.leaseExpired)) {
    await finishAttempt(tx, result, "expired", attempt.acceptedAt);
    return "dropped";
  }
  if (
    !heldLease || monitor.isPaused || monitor.configRev !== result.configRev ||
    attempt.configRev !== result.configRev || !attempt.timeValid || !attempt.isNewer
  ) {
    await finishAttempt(tx, result, "dropped", attempt.acceptedAt);
    return "dropped";
  }

  const observation = classifyCheck(attempt.expectedStatus, result);
  const hasStatus = "statusCode" in result;
  const checkedAt = attempt.checkedAt;
  const acceptedAt = attempt.acceptedAt;
  const inserted = await rows(tx, sql`
    INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,
      status_code,response_ms,error_type,redirect_count)
    VALUES (${result.attemptId},${result.monitorId},${result.configRev},${checkedAt}::timestamptz,
      ${observation.ok},${hasStatus ? result.statusCode : null},${hasStatus ? result.responseMs : null},
      ${observation.errorType},${result.redirectCount})
    ON CONFLICT (attempt_id) DO NOTHING RETURNING attempt_id
  `);
  if (!inserted.length) {
    await finishAttempt(tx, result, "dropped", acceptedAt);
    return "dropped";
  }

  const { state, delaySeconds, incident } = advanceCheck(monitor, observation, checkedAt, monitor.intervalSeconds);
  if (incident) await persistIncident(tx, monitor, result.monitorId, incident, acceptedAt);
  await tx.execute(sql`
    UPDATE monitors SET status=${state.status},failures=${state.failures},successes=${state.successes},
      streak_started_at=${state.streakStartedAt}::timestamptz,streak_first_error=${state.streakFirstError},
      last_checked_at=${checkedAt}::timestamptz,
      next_check_at=${acceptedAt}::timestamptz + ${delaySeconds}::double precision * interval '1 second',
      lease_id=NULL,lease_until=NULL
    WHERE id=${result.monitorId}
  `);
  await finishAttempt(tx, result, "done", acceptedAt);
  return "accepted";
}

/** Commit each signed observation independently. Responses never contain database error details. */
export async function ingestResults(
  db: DataExecutor,
  input: Parameters<CheckCapabilities["ingestResults"]>[0],
): ReturnType<CheckCapabilities["ingestResults"]> {
  const outcomes: { attemptId: string; outcome: CheckOutcome }[] = [];
  let accepted = 0;
  for (const result of input.results) {
    let outcome: CheckOutcome = "error";
    try {
      if (db.transaction) outcome = await db.transaction(tx => ingestOne(tx, result));
    } catch {
      // A failed observation does not roll back results committed before it.
    }
    if (outcome === "accepted") accepted++;
    outcomes.push({ attemptId: result.attemptId, outcome });
  }
  if (accepted > 0) {
    try {
      await db.execute(sql`UPDATE system_heartbeat SET last_ingested=${accepted} WHERE name='checker'`);
    } catch {
      // Telemetry cannot change a committed outcome.
    }
  }
  return outcomes;
}
