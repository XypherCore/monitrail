import { sql, type SQL } from "drizzle-orm";
import { canonicalPolicyHost } from "../../../shared/ssrf/address.ts";
import { prepareBlocklist, type BlockedHost } from "../../../shared/ssrf/blocklist.ts";
import type { DataExecutor } from "../data/access.ts";
import type { CheckCapabilities, ClaimedCheck } from "./capabilities.ts";
import { ingestResults } from "./check-ingest.ts";

type Candidate = { id: string; host: string };
type ClaimedRow = {
  attemptId: string;
  monitorId: string;
  configRev: number;
  url: string;
  expectedStatus: ClaimedCheck["expectedStatus"];
  dueAt: string | Date;
};

async function rows<T>(db: DataExecutor, statement: SQL): Promise<T[]> {
  const result = await db.execute(statement);
  return result.rows as T[];
}

function candidates(input: Candidate[]) {
  return sql`jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS target(id uuid, host text)`;
}

async function pauseBlocked(tx: DataExecutor, blocked: Candidate[], now: SQL) {
  if (blocked.length === 0) return;
  // A concurrent edit can change the target between the snapshot and the lock.
  // Match both the ID and the original host, and revisit busy rows next tick.
  await rows(tx, sql`
    WITH locked AS (
      SELECT m.id,m.lease_id FROM monitors m
      JOIN ${candidates(blocked)} ON m.id=target.id AND m.host=target.host
      WHERE m.pause_reason IS DISTINCT FROM 'blocked_host'
      ORDER BY m.id
      FOR UPDATE OF m SKIP LOCKED
    ), paused AS (
      UPDATE monitors m SET is_paused=true,pause_reason='blocked_host',
        config_rev=m.config_rev+1,lease_id=NULL,lease_until=NULL,
        failures=0,successes=0,streak_started_at=NULL,streak_first_error=NULL
      FROM locked WHERE m.id=locked.id
      RETURNING m.id,m.user_id,locked.lease_id AS previous_lease_id
    ), terminal AS (
      UPDATE check_attempts a SET
        state=CASE WHEN a.expires_at<=${now} THEN 'expired' ELSE 'dropped' END,
        terminal_at=greatest(${now},a.claimed_at)
      FROM paused p WHERE a.attempt_id=p.previous_lease_id AND a.monitor_id=p.id
        AND a.state='claimed'
    ), closed AS (
      UPDATE incidents i SET resolved_at=greatest(${now},i.started_at),resolved_reason='blocked'
      FROM paused p WHERE i.monitor_id=p.id AND i.user_id=p.user_id AND i.resolved_at IS NULL
    )
    INSERT INTO monitor_events(monitor_id,kind,at) SELECT id,'blocked',${now} FROM paused
  `);
}

async function leaseDue(tx: DataExecutor, eligible: Candidate[], now: SQL, max: 15) {
  if (eligible.length === 0) return [];
  return rows<ClaimedRow>(tx, sql`
    WITH due AS (
      SELECT m.id,m.lease_id FROM monitors m
      JOIN ${candidates(eligible)} ON m.id=target.id AND m.host=target.host
      WHERE NOT m.is_paused AND m.next_check_at<=${now}
        AND (m.lease_until IS NULL OR m.lease_until<=${now})
      ORDER BY m.next_check_at,m.id
      LIMIT ${max}
      FOR UPDATE OF m SKIP LOCKED
    ), leased AS (
      UPDATE monitors m SET lease_id=gen_random_uuid(),lease_until=${now}+interval '120 seconds'
      FROM due WHERE m.id=due.id
      RETURNING m.id,m.url,m.config_rev,m.expected_status,m.next_check_at,
        m.lease_id,m.lease_until,due.lease_id AS previous_lease_id
    ), expired AS (
      UPDATE check_attempts a SET state='expired',terminal_at=greatest(${now},a.claimed_at)
      FROM leased l WHERE a.attempt_id=l.previous_lease_id AND a.monitor_id=l.id AND a.state='claimed'
    ), attempts AS (
      INSERT INTO check_attempts(attempt_id,monitor_id,config_rev,expected_status,claimed_at,expires_at)
      SELECT lease_id,id,config_rev,expected_status,${now},lease_until FROM leased
      RETURNING attempt_id
    )
    SELECT l.lease_id AS "attemptId",l.id AS "monitorId",l.config_rev AS "configRev",
      l.url,l.expected_status AS "expectedStatus",l.next_check_at AS "dueAt"
    FROM leased l JOIN attempts a ON a.attempt_id=l.lease_id
    ORDER BY l.next_check_at,l.id
  `);
}

/** Service capability used only after signed internal request authentication. */
export function createCheckCapabilities(db: DataExecutor): CheckCapabilities {
  return {
    async claimChecks({ max }) {
      try {
        if (max !== 15 || !db.transaction) throw new Error();
        return await db.transaction(async (tx) => {
          const snapshot = await rows<BlockedHost>(tx, sql`
            SELECT host,include_subdomains AS "includeSubdomains" FROM blocked_hosts ORDER BY host
          `);
          const blocklist = snapshot.map(({ host, includeSubdomains }) => {
            const canonical = canonicalPolicyHost(host);
            if (!canonical || typeof includeSubdomains !== "boolean") throw new Error();
            return { host: canonical, includeSubdomains };
          });
          const isBlocked = prepareBlocklist(blocklist);
          const blocked: Candidate[] = [];
          const eligible: Candidate[] = [];
          const monitors = await rows<Candidate>(tx, sql`
            SELECT id,host FROM monitors WHERE pause_reason IS DISTINCT FROM 'blocked_host'
          `);
          for (const monitor of monitors) {
            (isBlocked(monitor.host) ? blocked : eligible).push(monitor);
          }
          const [stamp] = await rows<{ at: string }>(tx, sql`SELECT clock_timestamp()::text AS at`);
          const now = sql`${stamp.at}::timestamptz`;
          await pauseBlocked(tx, blocked, now);
          const leased = await leaseDue(tx, eligible, now, max);
          const jobs = leased.map((row) => {
            const dueAt = new Date(row.dueAt);
            if (!Number.isFinite(dueAt.getTime())) throw new Error();
            return { ...row, dueAt };
          });
          await rows(tx, sql`
            INSERT INTO system_heartbeat(name,last_tick_at,last_claimed)
              VALUES ('checker',${now},${jobs.length})
            ON CONFLICT(name) DO UPDATE SET last_tick_at=excluded.last_tick_at,last_claimed=excluded.last_claimed
            WHERE system_heartbeat.last_tick_at<=excluded.last_tick_at
          `);
          return { jobs, blocklist };
        }, { isolationLevel: "read committed" });
      } catch {
        throw new Error("Checker claim could not be completed.");
      }
    },

    ingestResults(input) {
      return ingestResults(db, input);
    },
  };
}
