import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().defaultRandom();

export const checkError = pgEnum("check_error", [
  "dns",
  "timeout",
  "tls",
  "connect",
  "bad_status",
  "blocked",
  "other",
]);
export const channelType = pgEnum("channel_type", ["telegram", "webhook", "discord", "slack"]);
export const alertKind = pgEnum("alert_kind", ["down", "up"]);

export const users = pgTable(
  "users",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email"),
    image: text("avatar_url"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_unique")
      .on(sql`lower(${table.email})`)
      .where(sql`${table.email} IS NOT NULL`),
  ],
);

export const accounts = pgTable(
  "accounts",
  {
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
    index("accounts_user_idx").on(table.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: time("expires").notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const invites = pgTable(
  "invites",
  {
    id: id(),
    codeHash: text("code_hash").notNull().unique(),
    createdAt: time("created_at").notNull().defaultNow(),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    usedAt: time("used_at"),
  },
  (table) => [
    check("invites_consumption_valid", sql`${table.usedBy} IS NULL OR ${table.usedAt} IS NOT NULL`),
  ],
);

export const monitors = pgTable(
  "monitors",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    host: text("host").notNull(),
    intervalSeconds: integer("interval_seconds").notNull().default(300),
    expectedStatus: text("expected_status", { enum: ["2xx", "2xx_3xx"] })
      .notNull()
      .default("2xx"),
    isPaused: boolean("is_paused").notNull().default(false),
    pauseReason: text("pause_reason", { enum: ["user", "blocked_host"] }),
    status: text("status", { enum: ["pending", "up", "down"] })
      .notNull()
      .default("pending"),
    configRev: integer("config_rev").notNull().default(1),
    failures: integer("failures").notNull().default(0),
    successes: integer("successes").notNull().default(0),
    streakStartedAt: time("streak_started_at"),
    streakFirstError: checkError("streak_first_error"),
    nextCheckAt: time("next_check_at").notNull().defaultNow(),
    lastCheckedAt: time("last_checked_at"),
    leaseId: uuid("lease_id"),
    leaseUntil: time("lease_until"),
    dnsCheckedAt: time("dns_checked_at"),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("monitors_id_owner_unique").on(table.id, table.userId),
    index("monitors_user_idx").on(table.userId),
    index("monitors_host_idx").on(table.host),
    index("monitors_due_idx").on(table.nextCheckAt).where(sql`${table.isPaused} = false`),
    check("monitors_interval_valid", sql`${table.intervalSeconds} IN (300,600,900,1800,3600)`),
    check("monitors_expected_status_valid", sql`${table.expectedStatus} IN ('2xx','2xx_3xx')`),
    check("monitors_status_valid", sql`${table.status} IN ('pending','up','down')`),
    check("monitors_pause_reason_valid", sql`${table.pauseReason} IN ('user','blocked_host')`),
    check("monitors_pause_consistent", sql`${table.isPaused} = (${table.pauseReason} IS NOT NULL)`),
    check("monitors_revision_positive", sql`${table.configRev} > 0`),
    check("monitors_counters_nonnegative", sql`${table.failures} >= 0 AND ${table.successes} >= 0`),
    check(
      "monitors_lease_consistent",
      sql`(${table.leaseId} IS NULL) = (${table.leaseUntil} IS NULL)`,
    ),
    check(
      "monitors_host_shape",
      sql`${table.host} <> '' AND ${table.host} = lower(${table.host}) AND right(${table.host},1) <> '.'`,
    ),
  ],
);

export const checkAttempts = pgTable(
  "check_attempts",
  {
    attemptId: uuid("attempt_id").primaryKey().defaultRandom(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    configRev: integer("config_rev").notNull(),
    expectedStatus: text("expected_status", { enum: ["2xx", "2xx_3xx"] }).notNull(),
    state: text("state", { enum: ["claimed", "done", "dropped", "expired"] })
      .notNull()
      .default("claimed"),
    claimedAt: time("claimed_at").notNull().defaultNow(),
    expiresAt: time("expires_at").notNull(),
    terminalAt: time("terminal_at"),
  },
  (table) => [
    index("check_attempts_monitor_idx").on(table.monitorId),
    check("check_attempts_revision_positive", sql`${table.configRev} > 0`),
    check(
      "check_attempts_expected_status_valid",
      sql`${table.expectedStatus} IN ('2xx','2xx_3xx')`,
    ),
    check(
      "check_attempts_state_valid",
      sql`${table.state} IN ('claimed','done','dropped','expired')`,
    ),
    check(
      "check_attempts_terminal_consistent",
      sql`(${table.state} = 'claimed') = (${table.terminalAt} IS NULL)`,
    ),
    check(
      "check_attempts_time_order",
      sql`${table.expiresAt} > ${table.claimedAt} AND (${table.terminalAt} IS NULL OR ${table.terminalAt} >= ${table.claimedAt})`,
    ),
  ],
);

export const checks = pgTable(
  "checks",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    // Attempts expire sooner than retained checks. Deliberately no attempt FK.
    attemptId: uuid("attempt_id").notNull().unique(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    configRev: integer("config_rev").notNull(),
    checkedAt: time("checked_at").notNull(),
    ok: boolean("ok").notNull(),
    statusCode: integer("status_code"),
    responseMs: integer("response_ms"),
    errorType: checkError("error_type"),
    redirectCount: integer("redirect_count").notNull().default(0),
  },
  (table) => [
    index("checks_monitor_time_idx").on(table.monitorId, table.checkedAt.desc()),
    check("checks_revision_positive", sql`${table.configRev} > 0`),
    check("checks_status_code_valid", sql`${table.statusCode} BETWEEN 100 AND 599`),
    check("checks_latency_nonnegative", sql`${table.responseMs} >= 0`),
    check("checks_redirect_count_valid", sql`${table.redirectCount} BETWEEN 0 AND 2`),
  ],
);

export const monitorEvents = pgTable(
  "monitor_events",
  {
    id: id(),
    monitorId: uuid("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["created", "paused", "resumed", "config_changed", "blocked"],
    }).notNull(),
    at: time("at").notNull().defaultNow(),
  },
  (table) => [
    index("monitor_events_monitor_time_idx").on(table.monitorId, table.at),
    check(
      "monitor_events_kind_valid",
      sql`${table.kind} IN ('created','paused','resumed','config_changed','blocked')`,
    ),
  ],
);

export const incidents = pgTable(
  "incidents",
  {
    id: id(),
    monitorId: uuid("monitor_id").notNull(),
    userId: uuid("user_id").notNull(),
    startedAt: time("started_at").notNull(),
    confirmedAt: time("confirmed_at").notNull(),
    resolvedAt: time("resolved_at"),
    resolvedConfirmedAt: time("resolved_confirmed_at"),
    resolvedReason: text("resolved_reason", {
      enum: ["recovered", "paused", "config_changed", "blocked"],
    }),
    cause: checkError("cause").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "incidents_monitor_owner_fk",
      columns: [table.monitorId, table.userId],
      foreignColumns: [monitors.id, monitors.userId],
    }).onDelete("cascade"),
    unique("incidents_id_owner_unique").on(table.id, table.userId),
    uniqueIndex("incidents_one_open_per_monitor")
      .on(table.monitorId)
      .where(sql`${table.resolvedAt} IS NULL`),
    index("incidents_monitor_time_idx").on(table.monitorId, table.startedAt.desc()),
    check(
      "incidents_reason_valid",
      sql`${table.resolvedReason} IN ('recovered','paused','config_changed','blocked')`,
    ),
    check("incidents_confirmation_order", sql`${table.confirmedAt} >= ${table.startedAt}`),
    check(
      "incidents_resolution_consistent",
      sql`(${table.resolvedAt} IS NULL) = (${table.resolvedReason} IS NULL)`,
    ),
    check(
      "incidents_resolution_order",
      sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.startedAt}`,
    ),
    check(
      "incidents_recovery_confirmation",
      sql`(${table.resolvedConfirmedAt} IS NULL OR (${table.resolvedAt} IS NOT NULL AND ${table.resolvedConfirmedAt} >= ${table.resolvedAt})) AND (${table.resolvedReason} IS DISTINCT FROM 'recovered' OR ${table.resolvedConfirmedAt} IS NOT NULL)`,
    ),
  ],
);

export const alertChannels = pgTable(
  "alert_channels",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: channelType("type").notNull(),
    label: text("label").notNull(),
    configEnc: text("config_enc").notNull(),
    isVerified: boolean("is_verified").notNull().default(false),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("alert_channels_id_owner_unique").on(table.id, table.userId),
    index("alert_channels_user_idx").on(table.userId),
  ],
);

export const telegramLinkCodes = pgTable(
  "telegram_link_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: time("expires_at").notNull(),
    usedAt: time("used_at"),
  },
  (table) => [index("telegram_link_codes_user_idx").on(table.userId)],
);

export const monitorAlertChannels = pgTable(
  "monitor_alert_channels",
  {
    monitorId: uuid("monitor_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.monitorId, table.channelId] }),
    foreignKey({
      name: "monitor_channels_monitor_owner_fk",
      columns: [table.monitorId, table.userId],
      foreignColumns: [monitors.id, monitors.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "monitor_channels_channel_owner_fk",
      columns: [table.channelId, table.userId],
      foreignColumns: [alertChannels.id, alertChannels.userId],
    }).onDelete("cascade"),
    index("monitor_channels_channel_idx").on(table.channelId),
  ],
);

export const alertOutbox = pgTable(
  "alert_outbox",
  {
    id: id(),
    incidentId: uuid("incident_id").notNull(),
    channelId: uuid("channel_id").notNull(),
    userId: uuid("user_id").notNull(),
    kind: alertKind("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull().unique(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status", { enum: ["pending", "sending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: time("next_attempt_at").notNull().defaultNow(),
    claimedUntil: time("claimed_until"),
    lastErrorCategory: checkError("last_error_category"),
    createdAt: time("created_at").notNull().defaultNow(),
    sentAt: time("sent_at"),
  },
  (table) => [
    foreignKey({
      name: "alert_outbox_incident_owner_fk",
      columns: [table.incidentId, table.userId],
      foreignColumns: [incidents.id, incidents.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "alert_outbox_channel_owner_fk",
      columns: [table.channelId, table.userId],
      foreignColumns: [alertChannels.id, alertChannels.userId],
    }).onDelete("cascade"),
    index("alert_outbox_channel_idx").on(table.channelId),
    check(
      "alert_outbox_dedupe_valid",
      sql`${table.dedupeKey} = ${table.incidentId}::text || ':' || ${table.channelId}::text || ':' || ${table.kind}::text`,
    ),
    check(
      "alert_outbox_status_valid",
      sql`${table.status} IN ('pending','sending','sent','failed')`,
    ),
    check("alert_outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check("alert_outbox_payload_object", sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);

export const statusPages = pgTable(
  "status_pages",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    isPublished: boolean("is_published").notNull().default(false),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("status_pages_id_owner_unique").on(table.id, table.userId),
    uniqueIndex("status_pages_slug_unique").on(sql`lower(${table.slug})`),
    index("status_pages_user_idx").on(table.userId),
    check("status_pages_slug_valid", sql`${table.slug} ~ '^[a-z0-9-]{3,40}$'`),
  ],
);

export const statusPageMonitors = pgTable(
  "status_page_monitors",
  {
    statusPageId: uuid("status_page_id").notNull(),
    monitorId: uuid("monitor_id").notNull(),
    userId: uuid("user_id").notNull(),
    position: integer("position").notNull().default(0),
    showUrl: boolean("show_url").notNull().default(false),
  },
  (table) => [
    primaryKey({ columns: [table.statusPageId, table.monitorId] }),
    foreignKey({
      name: "page_monitors_page_owner_fk",
      columns: [table.statusPageId, table.userId],
      foreignColumns: [statusPages.id, statusPages.userId],
    }).onDelete("cascade"),
    foreignKey({
      name: "page_monitors_monitor_owner_fk",
      columns: [table.monitorId, table.userId],
      foreignColumns: [monitors.id, monitors.userId],
    }).onDelete("cascade"),
    index("page_monitors_monitor_idx").on(table.monitorId),
  ],
);

export const slugTombstones = pgTable(
  "slug_tombstones",
  {
    slug: text("slug").primaryKey(),
    releasedAt: time("released_at").notNull(),
  },
  (table) => [check("slug_tombstones_slug_valid", sql`${table.slug} ~ '^[a-z0-9-]{3,40}$'`)],
);

export const blockedHosts = pgTable(
  "blocked_hosts",
  {
    host: text("host").primaryKey(),
    includeSubdomains: boolean("include_subdomains").notNull().default(true),
    reason: text("reason").notNull(),
    createdAt: time("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "blocked_hosts_host_shape",
      sql`${table.host} <> '' AND ${table.host} = lower(${table.host}) AND right(${table.host},1) <> '.'`,
    ),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: time("window_start").notNull(),
    count: integer("count").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.key, table.windowStart] }),
    check("rate_limits_count_nonnegative", sql`${table.count} >= 0`),
  ],
);

export const systemHeartbeat = pgTable(
  "system_heartbeat",
  {
    name: text("name").primaryKey(),
    lastTickAt: time("last_tick_at").notNull(),
    lastClaimed: integer("last_claimed").notNull().default(0),
    lastIngested: integer("last_ingested").notNull().default(0),
  },
  (table) => [
    check(
      "system_heartbeat_counts_nonnegative",
      sql`${table.lastClaimed} >= 0 AND ${table.lastIngested} >= 0`,
    ),
  ],
);
