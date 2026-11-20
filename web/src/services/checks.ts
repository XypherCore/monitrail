import { sql, type SQL } from "drizzle-orm";
import { canonicalPolicyHost } from "../../../shared/ssrf/address.ts";
import { prepareBlocklist, type BlockedHost } from "../../../shared/ssrf/blocklist.ts";
import type { DataExecutor } from "../data/access.ts";
import type { CheckCapabilities, ClaimedCheck } from "./capabilities.ts";
import { ingestResults } from "./check-ingest.ts";
import { pauseBlockedMonitors } from "./blocked-monitors.ts";

type Candidate = { id: string; host: string; configRev: number };
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
  return sql`jsonb_to_recordset(${JSON.stringify(input)}::jsonb) AS target(id uuid, host text, "configRev" int)`;
}

async function leaseDue(tx: DataExecutor, eligible: Candidate[], now: SQL, max: 15) {
  if (eligible.length === 0) return [];
  return rows<ClaimedRow>(tx, sql`
    WITH due AS (
      SELECT m.id,m.lease_id FROM monitors m
      JOIN ${candidates(eligible)} ON m.id=target.id AND m.host=target.host AND m.config_rev=target."configRev"
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
export function createCheckCapabilities(
  db: DataExecutor,
  invalidateStatus?: (slugs: readonly string[]) => void | Promise<void>,
): CheckCapabilities {
  return {
    async claimChecks({ max }) {
      try {
        if (max !== 15 || !db.transaction) throw new Error();
        const result = await db.transaction(async (tx) => {
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
            SELECT id,host,config_rev AS "configRev" FROM monitors WHERE pause_reason IS DISTINCT FROM 'blocked_host'
          `);
          for (const monitor of monitors) {
            (isBlocked(monitor.host) ? blocked : eligible).push(monitor);
          }
          const [stamp] = await rows<{ at: string }>(tx, sql`SELECT clock_timestamp()::text AS at`);
          const now = sql`${stamp.at}::timestamptz`;
          const paused = await pauseBlockedMonitors(tx, blocked, now);
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
          return { jobs, blocklist, slugs: paused.flatMap(({ slug }) => slug ? [slug] : []) };
        }, { isolationLevel: "read committed" });
        if (result.slugs.length) {
          try { await invalidateStatus?.(result.slugs); }
          catch { /* Public state is read live after commit. */ }
        }
        return { jobs: result.jobs, blocklist: result.blocklist };
      } catch {
        throw new Error("Checker claim could not be completed.");
      }
    },

    ingestResults(input) {
      return ingestResults(db, input);
    },
  };
}
