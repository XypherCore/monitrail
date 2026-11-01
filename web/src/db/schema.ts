import { sql } from "drizzle-orm";
import {
  bigserial, boolean, check, customType, doublePrecision, foreignKey,
  index, integer, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const id = () => uuid("id").primaryKey().defaultRandom();
const encryptedBytes = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const monitorStatus = pgEnum("monitor_status", ["pending", "up", "down", "paused"]);
export const checkError = pgEnum("check_error", ["dns", "timeout", "tls", "connect", "bad_status", "blocked", "other"]);
export const channelType = pgEnum("channel_type", ["telegram", "webhook"]);
export const alertKind = pgEnum("alert_kind", ["down", "up"]);

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  image: text("avatar_url"),
  emailVerified: boolean("email_verified").notNull().default(false),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
});

// Better Auth's documented core models. No auth handlers run in Phase 1.
export const accounts = pgTable("accounts", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: time("access_token_expires_at"),
  refreshTokenExpiresAt: time("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, table => [
  unique("accounts_provider_identity_unique").on(table.providerId, table.accountId),
  index("accounts_user_idx").on(table.userId),
  check("accounts_no_passwords", sql`${table.password} IS NULL`),
]);

export const sessions = pgTable("sessions", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: time("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, table => [index("sessions_user_idx").on(table.userId)]);

export const verification = pgTable("verification", {
  id: id(),
  // Pre-account verification may be anonymous; associate ownership when known.
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: time("expires_at").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
  updatedAt: time("updated_at").notNull().defaultNow(),
}, table => [
  index("verification_identifier_idx").on(table.identifier),
  index("verification_user_idx").on(table.userId),
]);

export const monitors = pgTable("monitors", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  method: text("method").notNull().default("GET"),
  intervalSeconds: integer("interval_seconds").notNull().default(300),
  timeoutMs: integer("timeout_ms").notNull().default(10000),
  expectedStatus: text("expected_status").notNull().default("2xx"),
  status: monitorStatus("status").notNull().default("pending"),
  isPaused: boolean("is_paused").notNull().default(false),
  failures: integer("failures").notNull().default(0),
  successes: integer("successes").notNull().default(0),
  nextCheckAt: time("next_check_at").notNull().defaultNow(),
  lastCheckedAt: time("last_checked_at"),
  createdAt: time("created_at").notNull().defaultNow(),
}, table => [
  unique("monitors_id_owner_unique").on(table.id, table.userId),
  index("monitors_user_idx").on(table.userId),
  index("monitors_due_idx").on(table.nextCheckAt).where(sql`${table.isPaused} = false`),
  check("monitors_interval_minimum", sql`${table.intervalSeconds} >= 300`),
  check("monitors_counters_nonnegative", sql`${table.failures} >= 0 AND ${table.successes} >= 0`),
  check("monitors_pause_consistent", sql`(${table.status} = 'paused') = ${table.isPaused}`),
]);

export const checks = pgTable("checks", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  checkedAt: time("checked_at").notNull(),
  ok: boolean("ok").notNull(),
  statusCode: integer("status_code"),
  responseMs: integer("response_ms"),
  errorType: checkError("error_type"),
}, table => [index("checks_monitor_time_idx").on(table.monitorId, table.checkedAt.desc())]);

export const checkRollupsHourly = pgTable("check_rollups_hourly", {
  monitorId: uuid("monitor_id").notNull().references(() => monitors.id, { onDelete: "cascade" }),
  hour: time("hour").notNull(),
  total: integer("total").notNull(),
  failed: integer("failed").notNull(),
  avgMs: doublePrecision("avg_ms"),
  p95Ms: doublePrecision("p95_ms"),
  maxMs: integer("max_ms"),
}, table => [
  primaryKey({ columns: [table.monitorId, table.hour] }),
  check("rollup_counts_valid", sql`${table.total} >= 0 AND ${table.failed} BETWEEN 0 AND ${table.total}`),
]);

export const incidents = pgTable("incidents", {
  id: id(),
  monitorId: uuid("monitor_id").notNull(),
  userId: uuid("user_id").notNull(),
  startedAt: time("started_at").notNull(),
  resolvedAt: time("resolved_at"),
  cause: checkError("cause").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
}, table => [
  foreignKey({ name: "incidents_monitor_owner_fk", columns: [table.monitorId, table.userId], foreignColumns: [monitors.id, monitors.userId] }).onDelete("cascade"),
  unique("incidents_id_owner_unique").on(table.id, table.userId),
  uniqueIndex("incidents_one_open_per_monitor").on(table.monitorId).where(sql`${table.resolvedAt} IS NULL`),
  index("incidents_monitor_time_idx").on(table.monitorId, table.startedAt.desc()),
  check("incidents_time_order", sql`${table.resolvedAt} IS NULL OR ${table.resolvedAt} >= ${table.startedAt}`),
]);

export const alertChannels = pgTable("alert_channels", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: channelType("type").notNull(),
  label: text("label").notNull(),
  configEncrypted: encryptedBytes("config_encrypted").notNull(),
  isVerified: boolean("is_verified").notNull().default(false),
  createdAt: time("created_at").notNull().defaultNow(),
}, table => [
  unique("alert_channels_id_owner_unique").on(table.id, table.userId),
  index("alert_channels_user_idx").on(table.userId),
]);

export const monitorAlertChannels = pgTable("monitor_alert_channels", {
  monitorId: uuid("monitor_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  userId: uuid("user_id").notNull(),
}, table => [
  primaryKey({ columns: [table.monitorId, table.channelId] }),
  foreignKey({ name: "monitor_channels_monitor_owner_fk", columns: [table.monitorId, table.userId], foreignColumns: [monitors.id, monitors.userId] }).onDelete("cascade"),
  foreignKey({ name: "monitor_channels_channel_owner_fk", columns: [table.channelId, table.userId], foreignColumns: [alertChannels.id, alertChannels.userId] }).onDelete("cascade"),
  index("monitor_channels_channel_idx").on(table.channelId),
]);

export const alertEvents = pgTable("alert_events", {
  id: id(),
  incidentId: uuid("incident_id").notNull(),
  channelId: uuid("channel_id").notNull(),
  userId: uuid("user_id").notNull(),
  kind: alertKind("kind").notNull(),
  sentAt: time("sent_at"),
  success: boolean("success").notNull().default(false),
  errorCategory: text("error_category"),
}, table => [
  foreignKey({ name: "alert_events_incident_owner_fk", columns: [table.incidentId, table.userId], foreignColumns: [incidents.id, incidents.userId] }).onDelete("cascade"),
  foreignKey({ name: "alert_events_channel_owner_fk", columns: [table.channelId, table.userId], foreignColumns: [alertChannels.id, alertChannels.userId] }).onDelete("cascade"),
  unique("alert_events_incident_channel_kind_unique").on(table.incidentId, table.channelId, table.kind),
  index("alert_events_channel_idx").on(table.channelId),
]);

export const statusPages = pgTable("status_pages", {
  id: id(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  isPublished: boolean("is_published").notNull().default(false),
  createdAt: time("created_at").notNull().defaultNow(),
}, table => [
  unique("status_pages_id_owner_unique").on(table.id, table.userId),
  index("status_pages_user_idx").on(table.userId),
  check("status_pages_slug_length", sql`char_length(${table.slug}) BETWEEN 3 AND 40`),
  check("status_pages_slug_lowercase", sql`${table.slug} = lower(${table.slug})`),
]);

export const statusPageMonitors = pgTable("status_page_monitors", {
  statusPageId: uuid("status_page_id").notNull(),
  monitorId: uuid("monitor_id").notNull(),
  userId: uuid("user_id").notNull(),
  position: integer("position").notNull().default(0),
  showUrl: boolean("show_url").notNull().default(false),
}, table => [
  primaryKey({ columns: [table.statusPageId, table.monitorId] }),
  foreignKey({ name: "page_monitors_page_owner_fk", columns: [table.statusPageId, table.userId], foreignColumns: [statusPages.id, statusPages.userId] }).onDelete("cascade"),
  foreignKey({ name: "page_monitors_monitor_owner_fk", columns: [table.monitorId, table.userId], foreignColumns: [monitors.id, monitors.userId] }).onDelete("cascade"),
  index("page_monitors_monitor_idx").on(table.monitorId),
]);

export const blockedHosts = pgTable("blocked_hosts", {
  id: id(),
  host: text("host").notNull().unique(),
  reason: text("reason").notNull(),
  createdAt: time("created_at").notNull().defaultNow(),
});
