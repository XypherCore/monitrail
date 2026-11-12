import { sql, type SQL } from "drizzle-orm";
import { canonicalPolicyHost, parseTarget } from "../../../shared/ssrf/address.ts";
import { isBlockedHost } from "../../../shared/ssrf/blocklist.ts";
import {
  isMonitorId,
  type MonitorEditFields,
  type MonitorFields,
  parseMonitorFields,
} from "../monitors/input.ts";
import { MONITOR_LIMITS } from "../monitors/limits.ts";
import { createWebGuard } from "../security/web-ssrf.ts";
import { createDataAccess, type DataExecutor } from "./access.ts";
import { reserveRollingLimits, urlValidationRateKey } from "./rolling-rate.ts";

type MonitorAccessCode =
  | "user_limit"
  | "global_limit"
  | "host_limit"
  | "validation_limit"
  | "channel_selection"
  | "blocked"
  | "blocked_resume"
  | "unavailable";
type StoredMonitor = {
  url: string;
  host: string;
  expected_status: MonitorFields["expectedStatus"];
  is_paused: boolean;
  pause_reason: "user" | "blocked_host" | null;
};
type GuardDependencies = Parameters<typeof createWebGuard>[1];

export class MonitorAccessError extends Error {
  readonly code: MonitorAccessCode;
  readonly retryAfterSeconds?: number;

  constructor(code: MonitorAccessCode, retryAfterSeconds?: number) {
    super("Monitor change could not be completed.");
    this.name = "MonitorAccessError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function rows<Row>(db: DataExecutor, query: SQL): Promise<Row[]> {
  return (await db.execute(query)).rows as Row[];
}

async function blocked(db: DataExecutor, host: string): Promise<boolean> {
  return isBlockedHost(
    host,
    await rows(db, sql`SELECT host, include_subdomains AS "includeSubdomains" FROM blocked_hosts`),
  );
}

async function lockGlobalQuota(tx: DataExecutor) {
  // Two-key advisory locks do not share the key space used by owner locks.
  await rows(tx, sql`SELECT pg_advisory_xact_lock(hashtext('monitor-quota'), 0)`);
}

const resetAttempt = sql`config_rev=config_rev+1, lease_id=NULL, lease_until=NULL,
  failures=0, successes=0, streak_started_at=NULL, streak_first_error=NULL`;

/** Private owner-bound writes. Quota and policy queries never return another owner's rows. */
export function createMonitorAccess(
  db: DataExecutor,
  userId: string,
  appUrl: string,
  guardDependencies?: GuardDependencies,
) {
  const { deleteMonitor, replaceMonitorChannels } = createDataAccess(db, userId);
  const ownerId = userId.toLowerCase();
  const guard = createWebGuard(
    {
      appUrl,
      async isBlockedHost(host, { signal }) {
        return signal.aborted || await blocked(db, host) || signal.aborted;
      },
    },
    guardDependencies,
  );

  async function write<T>(action: (tx: DataExecutor) => Promise<T>): Promise<T> {
    if (!db.transaction) throw new MonitorAccessError("unavailable");
    try {
      return await db.transaction(async (tx) => {
        await rows(tx, sql`SET LOCAL lock_timeout = '2s'`);
        await rows(tx, sql`SET LOCAL statement_timeout = '5s'`);
        await rows(tx, sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}::text, 0))`);
        return action(tx);
      }, { isolationLevel: "read committed" });
    } catch (error) {
      if (error instanceof MonitorAccessError) throw error;
      throw new MonitorAccessError("unavailable");
    }
  }

  async function reserveUrlValidation(id?: string): Promise<boolean> {
    return write(async (tx) => {
      if (id && !(await rows(tx, sql`SELECT 1 FROM monitors WHERE id=${id} AND user_id=${ownerId}`)).length)
        return false;
      if (!(await rows(tx, sql`SELECT 1 FROM users WHERE id=${ownerId} FOR KEY SHARE`)).length)
        throw new MonitorAccessError("unavailable");

      const retry = await reserveRollingLimits(tx,
        [{ key: urlValidationRateKey(ownerId), limit: MONITOR_LIMITS.validations }],
        MONITOR_LIMITS.validationWindowSeconds,
      );
      if (retry !== null) throw new MonitorAccessError("validation_limit", retry);
      return true;
    });
  }

  async function ownedForUpdate(tx: DataExecutor, id: string) {
    const [current] = await rows<StoredMonitor>(tx, sql`
      SELECT url,host,expected_status,is_paused,pause_reason
      FROM monitors WHERE id=${id} AND user_id=${ownerId} FOR UPDATE
    `);
    return current;
  }

  async function stamp(tx: DataExecutor): Promise<string> {
    const [instant] = await rows<{ at: string }>(tx, sql`SELECT clock_timestamp()::text AS at`);
    return instant.at;
  }

  async function event(
    tx: DataExecutor,
    id: string,
    kind: "created" | "paused" | "resumed" | "config_changed",
    at: string,
  ) {
    await rows(tx, sql`
      INSERT INTO monitor_events(monitor_id,kind,at) VALUES (${id},${kind},${at}::timestamptz)
    `);
  }

  async function closeIncident(
    tx: DataExecutor,
    id: string,
    reason: "paused" | "config_changed",
    at: string,
  ) {
    // Only ingest can resolve a recovered incident and enqueue its alert.
    await rows(tx, sql`
      UPDATE incidents
      SET resolved_at=greatest(${at}::timestamptz,started_at),resolved_reason=${reason}
      WHERE monitor_id=${id} AND user_id=${ownerId} AND resolved_at IS NULL
    `);
  }

  return {
    deleteMonitor,
    replaceMonitorChannels,

    async createMonitor(input: MonitorFields): Promise<{ id: string }> {
      const fields = parseMonitorFields(input, "create");
      await reserveUrlValidation();
      const target = await guard.validateMonitor(fields.url);

      return write(async (tx) => {
        await lockGlobalQuota(tx);
        if (await blocked(tx, target.host)) throw new MonitorAccessError("blocked");
        const [counts] = await rows<{ total: number; owned: number; sameHost: number }>(tx, sql`
          SELECT count(*)::int AS total, (count(*) FILTER (WHERE user_id=${ownerId}))::int AS owned,
            (count(*) FILTER (WHERE host=${target.host}))::int AS "sameHost"
          FROM monitors
        `);
        if (counts.owned >= MONITOR_LIMITS.user) throw new MonitorAccessError("user_limit");
        if (counts.total >= MONITOR_LIMITS.global) throw new MonitorAccessError("global_limit");
        if (counts.sameHost >= MONITOR_LIMITS.host) throw new MonitorAccessError("host_limit");

        const channelIds = fields.channelIds;
        const channels = channelIds?.length === 0 ? [] : await rows<{ id: string }>(tx, sql`
          SELECT id FROM alert_channels WHERE user_id=${ownerId} AND is_verified
          ${channelIds ? sql`AND id IN (${sql.join(channelIds.map((id) => sql`${id}`), sql`,`)})` : sql``}
          ORDER BY id FOR KEY SHARE
        `);
        if (channelIds && channels.length !== channelIds.length)
          throw new MonitorAccessError("channel_selection");

        const at = await stamp(tx);
        const [created] = await rows<{ id: string }>(tx, sql`
          INSERT INTO monitors(user_id,name,url,host,interval_seconds,expected_status,
            created_at,next_check_at,dns_checked_at)
          VALUES (${ownerId},${fields.name},${target.url},${target.host},${fields.intervalSeconds},
            ${fields.expectedStatus},${at}::timestamptz,${at}::timestamptz,${at}::timestamptz)
          RETURNING id
        `);
        await event(tx, created.id, "created", at);
        if (channels.length) {
          await rows(tx, sql`
            INSERT INTO monitor_alert_channels(user_id,monitor_id,channel_id) VALUES ${sql.join(
              channels.map(({ id }) => sql`(${ownerId},${created.id},${id})`), sql`,`,
            )}
          `);
        }
        return { id: created.id };
      });
    },

    async editMonitor(id: string, input: MonitorEditFields): Promise<boolean> {
      if (!isMonitorId(id)) return false;
      const fields = parseMonitorFields(input, "edit");
      let target: Awaited<ReturnType<typeof guard.validateMonitor>> | undefined;
      if (fields.url !== undefined) {
        if (!(await reserveUrlValidation(id))) return false;
        target = await guard.validateMonitor(fields.url);
      }

      return write(async (tx) => {
        if (target) await lockGlobalQuota(tx);
        const current = await ownedForUpdate(tx, id);
        if (!current) return false;
        if (target) {
          if (await blocked(tx, target.host)) throw new MonitorAccessError("blocked");
          if (target.host !== current.host) {
            const [count] = await rows<{ used: number }>(tx, sql`
              SELECT count(*)::int AS used FROM monitors WHERE host=${target.host}
            `);
            if (count.used >= MONITOR_LIMITS.host) throw new MonitorAccessError("host_limit");
          }
        }

        const reconfigured = (target !== undefined && target.url !== current.url) ||
          fields.expectedStatus !== current.expected_status;
        const at = await stamp(tx);
        const urlFields = target ? sql`
          , url=${target.url}, host=${target.host}, dns_checked_at=${at}::timestamptz,
          pause_reason=CASE WHEN pause_reason='blocked_host' THEN 'user' ELSE pause_reason END
        ` : sql``;
        const lifecycle = reconfigured ? sql`
          , ${resetAttempt}, status='pending', last_checked_at=NULL, next_check_at=${at}::timestamptz
        ` : sql``;
        await rows(tx, sql`
          UPDATE monitors SET name=${fields.name}, interval_seconds=${fields.intervalSeconds},
            expected_status=${fields.expectedStatus} ${urlFields} ${lifecycle}
          WHERE id=${id} AND user_id=${ownerId}
        `);
        if (reconfigured) {
          await closeIncident(tx, id, "config_changed", at);
          await event(tx, id, "config_changed", at);
        }
        return true;
      });
    },

    async setMonitorPaused(id: string, isPaused: boolean): Promise<boolean> {
      if (!isMonitorId(id)) return false;
      return write(async (tx) => {
        const current = await ownedForUpdate(tx, id);
        if (!current) return false;
        if (current.is_paused === isPaused) return true;
        if (!isPaused) {
          if (current.pause_reason === "blocked_host") throw new MonitorAccessError("blocked_resume");
          let host: string | null;
          try {
            host = canonicalPolicyHost(parseTarget(current.url).hostname);
          } catch {
            throw new MonitorAccessError("blocked_resume");
          }
          if (!host || host !== current.host || await blocked(tx, host))
            throw new MonitorAccessError("blocked_resume");
        }
        const at = await stamp(tx);
        const lifecycle = isPaused ? sql`pause_reason='user'` : sql`
          pause_reason=NULL, status='pending', last_checked_at=NULL, next_check_at=${at}::timestamptz
        `;
        await rows(tx, sql`
          UPDATE monitors SET is_paused=${isPaused}, ${lifecycle}, ${resetAttempt}
          WHERE id=${id} AND user_id=${ownerId}
        `);
        if (isPaused) await closeIncident(tx, id, "paused", at);
        await event(tx, id, isPaused ? "paused" : "resumed", at);
        return true;
      });
    },
  };
}
