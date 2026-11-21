import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { createChannelCipher } from "../../src/alerts/channel-crypto.ts";
import { MONITOR_LIMITS } from "../../src/monitors/limits.ts";
import { STORAGE_LIMIT_BYTES } from "../../src/services/health.ts";

type Database = ReturnType<typeof postgres>;
type TableSize = { table: string; rows: number; bytes: number };
export type StorageMeasurement = {
  model: {
    monitors: number; scheduledChecks: number; confirmationChecks: number;
    historyDays: number; incidentDays: number; outboxDays: number;
  };
  fixtureRows: Record<string, number>;
  tables: TableSize[];
  databaseBytes: number;
  planLimitBytes: number;
  percentOfPlan: number;
};

const tables = [
  "users", "accounts", "sessions", "invites", "monitors", "check_attempts",
  "checks", "monitor_events", "incidents", "alert_channels",
  "telegram_link_codes", "monitor_alert_channels", "alert_outbox",
  "status_pages", "status_page_monitors", "slug_tombstones", "blocked_hosts",
  "rate_limits", "system_heartbeat",
] as const;

/**
 * The caller creates, migrates and tears down the disposable Phase 10 database.
 * This module never reads environment files or opens a database connection.
 */
export async function measureStorage(
  database: Database,
  confirmation: { confirmSyntheticFixtures: true },
): Promise<StorageMeasurement> {
  if (confirmation?.confirmSyntheticFixtures !== true) {
    throw new Error("Explicit synthetic storage verification confirmation is required.");
  }
  let stage = "database guard";
  try {
    return await database.begin(async (tx) => {
      const [target] = await tx<{ name: string; address: string | null }[]>`
        SELECT current_database() AS name,host(inet_server_addr()) AS address
      `;
      if (!/^monitrail_phase10_[a-z0-9_]+$/.test(target.name) ||
        !["127.0.0.1", "::1"].includes(target.address ?? "")) throw new Error();
      await tx`SELECT pg_advisory_xact_lock(hashtext('storage-verification'),0)`;
      const [{ count }] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM monitors`;
      if (count !== 0) throw new Error();

      const [{ at }] = await tx<{ at: Date }[]>`SELECT clock_timestamp() AS at`;
      const shortId = randomUUID().slice(0, 8);
      const ratePrefix = `storage-fixture:${randomUUID()}:`;
      const owners = Array.from({ length: MONITOR_LIMITS.global / MONITOR_LIMITS.user }, () => ({
        id: randomUUID(), name: "Storage fixture owner", email: null,
      }));
      const ownerIds = owners.map(({ id }) => id);
      const monitors = owners.flatMap((owner, ownerIndex) =>
        Array.from({ length: MONITOR_LIMITS.user }, (_, monitorIndex) => ({
          id: randomUUID(), user_id: owner.id,
          name: `Storage fixture monitor ${ownerIndex * MONITOR_LIMITS.user + monitorIndex + 1}`,
          url: `https://storage-${shortId}-${ownerIndex}-${monitorIndex}.example.invalid/health`,
          host: `storage-${shortId}-${ownerIndex}-${monitorIndex}.example.invalid`,
          interval_seconds: 300, expected_status: "2xx", status: "up",
          created_at: new Date(at.getTime() - 365 * 86_400_000),
          last_checked_at: at, next_check_at: new Date(at.getTime() + 3_600_000), dns_checked_at: at,
        })),
      );
      const monitorIds = monitors.map(({ id }) => id);
      const cipher = createChannelCipher({
        CHANNEL_ENC_KEY: randomBytes(32).toString("base64url"), CHANNEL_ENC_KEY_ID: "storage-fixture",
      });
      const channels = owners.flatMap((owner) =>
        Array.from({ length: 3 }, () => {
          const id = randomUUID();
          return {
            id, user_id: owner.id, type: "webhook", label: "Storage fixture channel", is_verified: true,
            config_enc: cipher.encrypt(
              { url: `https://recipient.example.invalid/fixture/${randomUUID()}` },
              { id, userId: owner.id, type: "webhook" },
            ),
          };
        }),
      );
      const pages = owners.flatMap((owner, ownerIndex) =>
        Array.from({ length: 3 }, (_, pageIndex) => ({
          id: randomUUID(), user_id: owner.id,
          slug: `storage-${shortId}-${ownerIndex}-${pageIndex}`,
          title: "Storage fixture status", is_published: true,
        })),
      );
      const heldSlugs = Array.from({ length: 40 }, (_, index) => `storage-held-${shortId}-${index}`);
      const blockedHost = `blocked-storage-${shortId}.example.invalid`;

      stage = "account and monitor fixtures";
      await tx`INSERT INTO users ${tx(owners)}`;
      await tx`INSERT INTO monitors ${tx(monitors)}`;
      await tx`INSERT INTO alert_channels ${tx(channels)}`;
      await tx`INSERT INTO status_pages ${tx(pages)}`;
      await tx`
        INSERT INTO monitor_alert_channels(monitor_id,channel_id,user_id)
        SELECT m.id,c.id,m.user_id FROM monitors m JOIN alert_channels c ON c.user_id=m.user_id
        WHERE m.user_id=ANY(${ownerIds}::uuid[])
      `;
      await tx`
        INSERT INTO status_page_monitors(status_page_id,monitor_id,user_id,position)
        SELECT p.id,m.id,p.user_id,(row_number() OVER (PARTITION BY p.id ORDER BY m.id)-1)::int
        FROM status_pages p JOIN monitors m ON m.user_id=p.user_id WHERE p.user_id=ANY(${ownerIds}::uuid[])
      `;
      for (const owner of owners) {
        await tx`
          INSERT INTO accounts(provider,provider_account_id,user_id)
          VALUES ('github',${`storage:${randomUUID()}`},${owner.id}),
            ('google',${`storage:${randomUUID()}`},${owner.id})
        `;
        await tx`
          INSERT INTO sessions(session_token,user_id,expires)
          VALUES (${randomUUID()},${owner.id},${new Date(at.getTime() + 86_400_000)}),
            (${randomUUID()},${owner.id},${new Date(at.getTime() + 86_400_000)})
        `;
        await tx`
          INSERT INTO invites(code_hash,used_by,used_at)
          VALUES (${createHash("sha256").update(randomBytes(32)).digest("hex")},${owner.id},${at})
        `;
        await tx`
          INSERT INTO telegram_link_codes(code_hash,user_id,expires_at)
          VALUES (${createHash("sha256").update(randomBytes(32)).digest("hex")},
            ${owner.id},${new Date(at.getTime() + 600_000)})
        `;
      }
      await tx`
        INSERT INTO slug_tombstones(slug,released_at)
        SELECT slug,${at}::timestamptz+interval '29 days' FROM unnest(${heldSlugs}::text[]) AS slug
      `;
      await tx`INSERT INTO blocked_hosts(host,reason) VALUES (${blockedHost},'Storage fixture')`;

      stage = "scheduled and confirmation check fixtures";
      await tx`
        INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms,redirect_count)
        SELECT gen_random_uuid(),m.id,1,
          ${at}::timestamptz-interval '30 days'+slot*interval '300 seconds',true,200,120+(slot%80),0
        FROM monitors m CROSS JOIN generate_series(0,8639) AS slot WHERE m.id=ANY(${monitorIds}::uuid[])
      `;
      // Explicit 20% confirmation overhead supplements the five-minute schedule.
      await tx`
        INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms,error_type,redirect_count)
        SELECT gen_random_uuid(),m.id,1,
          ${at}::timestamptz-interval '30 days'+slot*interval '1500 seconds'+interval '60 seconds',
          slot%2=1,CASE WHEN slot%2=1 THEN 200 END,CASE WHEN slot%2=1 THEN 140 END,
          CASE WHEN slot%2=0 THEN 'timeout'::check_error END,0
        FROM monitors m CROSS JOIN generate_series(0,1727) AS slot WHERE m.id=ANY(${monitorIds}::uuid[])
      `;

      stage = "yearly history and ninety-day alert fixtures";
      await tx`
        INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,resolved_at,
          resolved_confirmed_at,resolved_reason,cause,created_at)
        SELECT m.id,m.user_id,${at}::timestamptz-day*interval '1 day',
          ${at}::timestamptz-day*interval '1 day'+interval '60 seconds',
          ${at}::timestamptz-day*interval '1 day'+interval '5 minutes',
          ${at}::timestamptz-day*interval '1 day'+interval '6 minutes',
          'recovered','timeout',${at}::timestamptz-day*interval '1 day'+interval '60 seconds'
        FROM monitors m CROSS JOIN generate_series(1,365) AS day WHERE m.id=ANY(${monitorIds}::uuid[])
      `;
      await tx`
        INSERT INTO monitor_events(monitor_id,kind,at)
        SELECT id,'created',created_at FROM monitors WHERE id=ANY(${monitorIds}::uuid[])
      `;
      await tx`
        INSERT INTO monitor_events(monitor_id,kind,at)
        SELECT m.id,kind,${at}::timestamptz-day*interval '1 day'+delay
        FROM monitors m CROSS JOIN generate_series(1,365) AS day
        CROSS JOIN (VALUES ('paused',interval '10 minutes'),('resumed',interval '20 minutes')) AS event(kind,delay)
        WHERE m.id=ANY(${monitorIds}::uuid[])
      `;
      await tx`
        INSERT INTO alert_outbox(incident_id,channel_id,user_id,kind,dedupe_key,payload,status,attempts,created_at,sent_at)
        SELECT i.id,c.id,i.user_id,event.kind,i.id::text||':'||c.id::text||':'||event.kind::text,
          jsonb_build_object('version',1,
            'event',CASE WHEN event.kind='down' THEN 'incident.opened' ELSE 'incident.resolved' END,
            'event_id',gen_random_uuid()::text,'monitor',jsonb_build_object('name','Storage fixture monitor'),
            'incident',jsonb_build_object('started_at',i.started_at,'confirmed_at',i.confirmed_at,
              'resolved_at',i.resolved_at,'cause',i.cause),
            'sent_at',CASE WHEN event.kind='down' THEN i.confirmed_at ELSE i.resolved_confirmed_at END),
          'sent',1,CASE WHEN event.kind='down' THEN i.confirmed_at ELSE i.resolved_confirmed_at END,
          CASE WHEN event.kind='down' THEN i.confirmed_at ELSE i.resolved_confirmed_at END+interval '2 seconds'
        FROM incidents i JOIN alert_channels c ON c.user_id=i.user_id
        CROSS JOIN (VALUES ('down'::alert_kind),('up'::alert_kind)) AS event(kind)
        WHERE i.user_id=ANY(${ownerIds}::uuid[]) AND i.started_at>=${at}::timestamptz-interval '90 days'
      `;

      stage = "current-day attempt and rate fixtures";
      await tx`
        INSERT INTO check_attempts(monitor_id,config_rev,expected_status,state,claimed_at,expires_at,terminal_at)
        SELECT m.id,1,'2xx','done',${at}::timestamptz-interval '1 day'+slot*interval '250 seconds',
          ${at}::timestamptz-interval '1 day'+slot*interval '250 seconds'+interval '120 seconds',
          ${at}::timestamptz-interval '1 day'+slot*interval '250 seconds'+interval '1 second'
        FROM monitors m CROSS JOIN generate_series(0,344) AS slot WHERE m.id=ANY(${monitorIds}::uuid[])
      `;
      await tx`
        INSERT INTO check_attempts(monitor_id,config_rev,expected_status,claimed_at,expires_at)
        SELECT id,1,'2xx',${at},${at}::timestamptz+interval '120 seconds'
        FROM monitors WHERE id=ANY(${monitorIds}::uuid[])
      `;
      await tx`
        INSERT INTO rate_limits(key,window_start,count)
        SELECT ${ratePrefix}||'nonce:'||gen_random_uuid()::text,
          ${at}::timestamptz-interval '1 day'+slot*interval '30 seconds',1 FROM generate_series(1,2880) AS slot
      `;
      await tx`
        INSERT INTO rate_limits(key,window_start,count)
        SELECT ${ratePrefix}||'monitor-url:'||u.id::text,
          ${at}::timestamptz-interval '1 day'+slot*interval '120 seconds',1
        FROM users u CROSS JOIN generate_series(1,720) AS slot WHERE u.id=ANY(${ownerIds}::uuid[])
      `;
      await tx`
        INSERT INTO rate_limits(key,window_start,count)
        SELECT ${ratePrefix}||purpose||':'||u.id::text,
          ${at}::timestamptz-interval '1 day'+slot*interval '12 minutes',1
        FROM users u CROSS JOIN generate_series(1,120) AS slot
        CROSS JOIN (VALUES ('alert-test:user'),('alert-test:channel'),('telegram-link')) AS rate(purpose)
        WHERE u.id=ANY(${ownerIds}::uuid[])
      `;
      await tx`
        INSERT INTO rate_limits(key,window_start,count)
        SELECT ${ratePrefix}||'auth-rate:'||slot,${at},3 FROM generate_series(1,20) AS slot
      `;

      stage = "physical table and index measurement";
      const relationSizes = await tx<{ table: string; bytes: number }[]>`
        SELECT c.relname AS "table",pg_total_relation_size(c.oid)::double precision AS bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY(${tables}::text[]) ORDER BY c.relname
      `;
      const measuredTables: TableSize[] = [];
      for (const table of tables) {
        const [{ rows }] = await tx<{ rows: number }[]>`SELECT count(*)::int AS rows FROM ${tx(table)}`;
        const relation = relationSizes.find((entry) => entry.table === table);
        if (!relation || !Number.isSafeInteger(relation.bytes)) throw new Error();
        measuredTables.push({ table, rows, bytes: relation.bytes });
      }
      const [{ bytes }] = await tx<{ bytes: number }[]>`
        SELECT pg_database_size(current_database())::double precision AS bytes
      `;
      const fixtureRows = Object.fromEntries(measuredTables.map(({ table, rows }) => [table, rows]));
      if (fixtureRows.monitors !== MONITOR_LIMITS.global || fixtureRows.checks !== 414_720 ||
        fixtureRows.incidents !== 14_600 || fixtureRows.alert_outbox !== 21_600) throw new Error();
      const measurement: StorageMeasurement = {
        model: { monitors: MONITOR_LIMITS.global, scheduledChecks: 345_600, confirmationChecks: 69_120,
          historyDays: 30, incidentDays: 365, outboxDays: 90 },
        fixtureRows, tables: measuredTables, databaseBytes: bytes, planLimitBytes: STORAGE_LIMIT_BYTES,
        percentOfPlan: bytes / STORAGE_LIMIT_BYTES * 100,
      };
      stage = "storage threshold";
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes >= STORAGE_LIMIT_BYTES * 0.6) throw new Error();

      stage = "fixture cleanup";
      await tx`DELETE FROM invites WHERE used_by=ANY(${ownerIds}::uuid[])`;
      await tx`DELETE FROM users WHERE id=ANY(${ownerIds}::uuid[])`;
      await tx`DELETE FROM rate_limits WHERE starts_with(key,${ratePrefix})`;
      await tx`DELETE FROM blocked_hosts WHERE host=${blockedHost}`;
      await tx`DELETE FROM slug_tombstones WHERE slug=ANY(${[...heldSlugs, ...pages.map(({ slug }) => slug)]}::text[])`;
      return measurement;
    });
  } catch {
    throw new Error(`Synthetic storage verification failed during ${stage}.`);
  }
}
