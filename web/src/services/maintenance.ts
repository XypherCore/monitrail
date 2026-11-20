import { sql, type SQL } from "drizzle-orm";
import { canonicalPolicyHost } from "../../../shared/ssrf/address.ts";
import { prepareBlocklist, type BlockedHost } from "../../../shared/ssrf/blocklist.ts";
import { awaitSignal } from "../../../shared/ssrf/io.ts";
import type { DataExecutor } from "../data/access.ts";
import type { createWebGuard } from "../security/web-ssrf.ts";
import { pauseBlockedMonitors } from "./blocked-monitors.ts";
import type { MaintenanceCapability } from "./capabilities.ts";
import { STORAGE_LIMIT_BYTES } from "./health.ts";

const DNS_BUDGET_MS = 45_000;
const DNS_PARALLELISM = 6;
type Candidate = {
  id: string; host: string; url: string; configRev: number;
  due: boolean; pauseReason: string | null;
};
type Dependencies = {
  validateMonitor: ReturnType<typeof createWebGuard>["validateMonitor"];
  invalidateStatus?(slugs: readonly string[]): void | Promise<void>;
  log(summary: Record<string, unknown>): void;
};

async function rows<T>(db: DataExecutor, statement: SQL): Promise<T[]> {
  return (await db.execute(statement)).rows as T[];
}

async function transaction<T>(db: DataExecutor, run: (tx: DataExecutor) => Promise<T>): Promise<T> {
  if (!db.transaction) throw new Error();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return run(tx);
  }, { isolationLevel: "read committed" });
}

async function cleanup(db: DataExecutor, at: string) {
  const now = sql`${at}::timestamptz`;
  return transaction(db, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('maintenance-cleanup'),0)`);
    // Ingest locks the monitor before the attempt. Use that same order.
    await tx.execute(sql`
      WITH locked AS MATERIALIZED (
        SELECT m.id,m.lease_id FROM monitors m WHERE EXISTS (
          SELECT 1 FROM check_attempts a WHERE a.monitor_id=m.id AND a.state='claimed' AND a.expires_at<=${now}
        ) ORDER BY m.id FOR UPDATE OF m SKIP LOCKED
      ), expired AS (
        UPDATE check_attempts a SET state='expired',terminal_at=a.expires_at
        FROM locked l WHERE a.monitor_id=l.id AND a.state='claimed' AND a.expires_at<=${now}
      )
      UPDATE monitors m SET lease_id=NULL,lease_until=NULL
      FROM locked l WHERE m.id=l.id AND m.lease_until<=${now}
    `);
    const [{ removed }] = await rows<{ removed: number }>(tx, sql`
      WITH checks_removed AS (DELETE FROM checks WHERE checked_at<${now}-interval '30 days' RETURNING 1),
      attempts_removed AS (DELETE FROM check_attempts WHERE state<>'claimed' AND terminal_at<${now}-interval '1 day' RETURNING 1),
      outbox_removed AS (DELETE FROM alert_outbox WHERE status='sent' AND sent_at<${now}-interval '90 days' RETURNING 1),
      limits_removed AS (DELETE FROM rate_limits WHERE window_start<${now}-interval '1 day' RETURNING 1),
      codes_removed AS (DELETE FROM telegram_link_codes WHERE expires_at<=${now} RETURNING 1),
      tombstones_removed AS (DELETE FROM slug_tombstones WHERE released_at<=${now} RETURNING 1),
      sessions_removed AS (DELETE FROM sessions WHERE expires<=${now} RETURNING 1),
      incidents_removed AS (DELETE FROM incidents WHERE resolved_at<${now}-interval '1 year' RETURNING 1),
      events_removed AS (
        DELETE FROM monitor_events e WHERE e.at<${now}-interval '1 year' AND (
          e.kind NOT IN ('paused','resumed','blocked') OR EXISTS (
            SELECT 1 FROM monitor_events later WHERE later.monitor_id=e.monitor_id
              AND later.kind IN ('paused','resumed','blocked') AND later.at<${now}-interval '1 year'
              AND (later.at,later.id)>(e.at,e.id)
          )
        ) RETURNING 1
      )
      SELECT (SELECT count(*) FROM checks_removed)+(SELECT count(*) FROM attempts_removed)+
        (SELECT count(*) FROM outbox_removed)+(SELECT count(*) FROM limits_removed)+
        (SELECT count(*) FROM codes_removed)+(SELECT count(*) FROM tombstones_removed)+
        (SELECT count(*) FROM sessions_removed)+(SELECT count(*) FROM incidents_removed)+
        (SELECT count(*) FROM events_removed) AS removed
    `);
    return Number(removed);
  });
}

/** Daily internal capability. DNS validation never opens an HTTP connection. */
export function createMaintenanceCapability(db: DataExecutor, dependencies: Dependencies): MaintenanceCapability {
  return {
    async runMaintenance() {
      try {
        const [{ at, day }] = await rows<{ at: string; day: string }>(db, sql`
          SELECT clock_timestamp()::text AS at,
            (date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::text AS day
        `);
        const removed = await cleanup(db, at);
        const entries = await rows<BlockedHost>(db, sql`SELECT host,include_subdomains AS "includeSubdomains" FROM blocked_hosts`);
        const isBlocked = prepareBlocklist(entries.map((entry) => {
          if (canonicalPolicyHost(entry.host) !== entry.host || typeof entry.includeSubdomains !== "boolean") throw new Error();
          return entry;
        }));
        const candidates = await rows<Candidate>(db, sql`
          SELECT id,host,url,config_rev AS "configRev",pause_reason AS "pauseReason",
            (dns_checked_at IS NULL OR dns_checked_at<${day}::timestamptz) AS due
          FROM monitors ORDER BY dns_checked_at NULLS FIRST,id
        `);
        const targets = candidates.filter((target) => target.due ||
          (isBlocked(target.host) && target.pauseReason !== "blocked_host"));
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), DNS_BUDGET_MS);
        let cursor = 0;
        let dnsRevalidated = 0;
        let blocked = 0;
        async function validateNext() {
          for (let index = cursor++; index < targets.length && !deadline.signal.aborted; index = cursor++) {
            const target = targets[index];
            let unsafe = isBlocked(target.host);
            if (!unsafe) {
              try {
                await awaitSignal(dependencies.validateMonitor(target.url), deadline.signal);
              } catch {
                if (deadline.signal.aborted) return;
                unsafe = true;
              }
            }
            if (deadline.signal.aborted) return;
            const changed = await transaction(db, async (tx) => {
              const [current] = await rows<{ id: string }>(tx, sql`
                SELECT id FROM monitors WHERE id=${target.id} AND host=${target.host}
                  AND url=${target.url} AND config_rev=${target.configRev}
                  AND ((dns_checked_at IS NULL OR dns_checked_at<${day}::timestamptz)
                    OR (${isBlocked(target.host)} AND pause_reason IS DISTINCT FROM 'blocked_host'))
                FOR UPDATE SKIP LOCKED
              `);
              if (!current) return null;
              const [{ checkedAt }] = await rows<{ checkedAt: string }>(tx,
                sql`SELECT clock_timestamp()::text AS "checkedAt"`);
              const paused = unsafe ? await pauseBlockedMonitors(tx, [target], sql`${checkedAt}::timestamptz`) : [];
              await tx.execute(sql`UPDATE monitors SET dns_checked_at=${checkedAt}::timestamptz WHERE id=${target.id}`);
              return {
                blocked: paused.length ? 1 : 0,
                slugs: [...new Set(paused.flatMap(({ slug }) => slug ? [slug] : []))],
              };
            });
            if (!changed) continue;
            dnsRevalidated++;
            blocked += changed.blocked;
            if (changed.slugs.length) {
              try { await dependencies.invalidateStatus?.(changed.slugs); }
              catch { /* Public state is read live after commit. */ }
            }
          }
        }
        try {
          await Promise.all(Array.from({ length: Math.min(DNS_PARALLELISM, targets.length) }, validateNext));
        } finally {
          clearTimeout(timer);
          deadline.abort();
        }
        const tableSizes = await rows<{ table: string; bytes: number }>(db, sql`
          SELECT c.relname AS "table",pg_total_relation_size(c.oid)::double precision AS bytes
          FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relkind='r' AND c.relname IN (
            'users','accounts','sessions','invites','monitors','check_attempts','checks',
            'monitor_events','incidents','alert_channels','telegram_link_codes',
            'monitor_alert_channels','alert_outbox','status_pages','status_page_monitors',
            'slug_tombstones','blocked_hosts','rate_limits','system_heartbeat'
          ) ORDER BY c.relname
        `);
        const [{ bytes }] = await rows<{ bytes: number }>(db, sql`
          SELECT pg_database_size(current_database())::double precision AS bytes
        `);
        dependencies.log({ removed, dnsRevalidated, blocked, tableSizes,
          storageBytes: bytes, storageWarning: bytes >= STORAGE_LIMIT_BYTES * 0.8 });
        return { removed, dnsRevalidated, blocked };
      } catch {
        throw new Error("Maintenance could not be completed.");
      }
    },
  };
}
