# 05 — Backend Schema: Monitrail

PostgreSQL (Neon). Migrations via drizzle-kit. All timestamps `timestamptz`
in UTC. Primary keys are `uuid` unless noted.

## Tables
**users** — id, email (unique), name, avatar_url, email_verified (bool default
false), created_at, updated_at. Better Auth's `image` property maps to
`avatar_url`. Auth table IDs are UUIDs, using its documented UUID configuration
when auth is implemented in Phase 2.

**accounts** — id, user_id (FK users, cascade), account_id, provider_id,
access_token, refresh_token, id_token, access_token_expires_at,
refresh_token_expires_at, scope, password, created_at, updated_at.
Unique (provider_id, account_id). Optional token fields remain nullable;
no tokens are seeded. A CHECK requires password IS NULL: OAuth only, no
password storage or credential authentication is introduced. Phase 2 must
configure provider/token handling and encrypted token storage appropriately.

**sessions** — id, user_id (FK users, cascade), token (unique), expires_at,
ip_address (nullable), user_agent (nullable), created_at, updated_at.

**verification** — id, identifier, value, expires_at, created_at, updated_at,
user_id (nullable FK users, cascade). The owner must be associated whenever
known; anonymous pre-account records have no user to cascade from and need
expiry cleanup. These follow Better Auth's documented core model, with the
additional nullable owner reference; no auth runtime is implemented in Phase 1.

**monitors**
id, user_id (FK users, cascade delete), name, url, method (default GET),
interval_seconds (default 300, check >= 300), timeout_ms (default 10000),
expected_status (default '2xx'), status ('pending' | 'up' | 'down' |
'paused'), is_paused (bool), failures (int), successes (int),
next_check_at, last_checked_at, created_at.
Indexes: (user_id), (next_check_at) WHERE is_paused = false.

**checks** (raw results, 30-day retention)
id (bigserial), monitor_id (FK, cascade), checked_at, ok (bool),
status_code (int null), response_ms (int null),
error_type (null | 'dns' | 'timeout' | 'tls' | 'connect' | 'bad_status' |
'blocked' | 'other').
Index: (monitor_id, checked_at DESC).

**check_rollups_hourly**
monitor_id, hour, total, failed, avg_ms, p95_ms, max_ms.
PK (monitor_id, hour). Written by the maintenance job before raw rows are
deleted.

**incidents**
id, monitor_id (FK, cascade), started_at, resolved_at (null while open),
cause (first error_type), created_at.
Includes user_id (not null), with composite (monitor_id, user_id) referencing
the monitor and cascading on deletion. Partial unique index:
(monitor_id) WHERE resolved_at IS NULL, so a monitor
can never have two open incidents.
Index: (monitor_id, started_at DESC).

**alert_channels**
id, user_id (FK, cascade), type ('telegram' | 'webhook'), label,
config_encrypted (AES-256-GCM, includes nonce), is_verified (bool),
created_at.

**monitor_alert_channels** — monitor_id, channel_id, user_id (not null).
PK (monitor_id, channel_id). Composite owner foreign keys reference both
the monitor and channel and cascade on deletion, preventing cross-user links.

**alert_events**
id, incident_id, channel_id, user_id (not null), kind ('down' | 'up'), sent_at,
success (bool), error_category (text null).
Composite owner foreign keys reference both the incident and channel and
cascade on deletion. Unique (incident_id, channel_id, kind) deduplicates
event records; external delivery guarantees still require the Phase 7 design.

**status_pages** — id, user_id (FK, cascade), slug (unique, 3-40 chars,
lowercase, reserved words blocked), title, is_published (bool), created_at.

**status_page_monitors** — status_page_id, monitor_id, position,
show_url (bool default false), user_id (not null). PK (status_page_id, monitor_id).
Composite owner foreign keys reference both the page and monitor and cascade
on deletion. The database enforces slug length and lowercase; the owner must
supply the reserved-word policy before Phase 8 exposes page creation.

**blocked_hosts** — id, host (unique), reason, created_at. Checked at creation
and before every check.

## Relationships
users 1-N monitors; monitors 1-N checks, incidents; incidents 1-N
alert_events; users 1-N alert_channels, status_pages; monitors N-N
alert_channels; status_pages N-N monitors.

## Authorization model
- One role: signed-in user. The system owner is not a role in the app.
- All reads and writes go through a data-access layer that takes `userId`
  and filters by ownership (directly or via the owning monitor).
- Route handlers never query tables directly.
- Public status page queries are separate, read-only, and select only
  explicitly public columns.
- Deleting a user cascades to all of their data (account deletion is real).
- Every declared owned relationship, including checks, rollups and auth
  owner references, has an explicit cascade. Owners on cross-object links
  are NOT NULL and are checked against both referenced rows. This integrity
  protection supplements, and does not replace, the Phase 2 ownership DAL.
- Phase 1 migration, fixture and database-verification scripts are privileged
  administrative tooling, separate from application queries and routes.
  They do not provide an application database client or bypass API.

## Sensitive fields
- alert_channels.config_encrypted: encrypted at rest, never logged, never
  returned to the client after creation (show only a masked label).
- Response bodies and headers from monitored sites are never stored.

## Quotas (enforced in the data-access layer, not only the UI)
10 monitors per user, 5-minute minimum interval, global monitor cap, a
per-hostname cap across all users.

## Internal API (HMAC-signed, Worker only)
- `GET  /api/internal/due`: returns up to 40 monitors with
  next_check_at <= now, not paused, host not blocked. Returns id and URL only.
- `POST /api/internal/ingest`: batch of {monitor_id, checked_at, ok,
  status_code, response_ms, error_type}. Writes checks, runs the state
  machine, schedules next_check_at, sends alerts.
- `POST /api/internal/maintenance`: daily. Builds hourly rollups, deletes raw
  checks older than 30 days.
Signature: HMAC-SHA256 over `timestamp + "." + body`; headers
`x-ts` and `x-sig`; reject on more than 60 s skew.

## Uptime definition
Uptime % = successful checks / total checks in the window (check-based).
Downtime duration comes from incidents. Document this on the UI so numbers
are never ambiguous.
