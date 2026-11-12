# 05 — Backend Schema: Monitrail (rev 2)

PostgreSQL. Migrations via drizzle-kit. Timestamps are `timestamptz` (UTC).
Primary keys are `uuid` unless noted. **Every foreign key is `ON DELETE
CASCADE` unless this document says otherwise**, so deleting a user removes
all of their data.

## Auth tables
Per Auth.js with database sessions. Identify accounts by
(`provider`, `provider_account_id`); never link by email. `users.email` is
nullable. OAuth access and refresh tokens are not persisted unless the
library cannot work without them.
- `users`: id, name, email (nullable), avatar_url, created_at.
- `accounts`: provider, provider_account_id, user_id. PK (provider,
  provider_account_id).
- `sessions`: session_token (PK), user_id, expires.
- `invites`: id, code_hash (unique), created_at, used_by (FK users, ON DELETE
  SET NULL), used_at. Used while `SIGNUP_MODE=invite`.

## Monitoring tables
**monitors**
id, user_id, name, url, host (canonical host, see below),
interval_seconds (CHECK in 300, 600, 900, 1800, 3600),
expected_status (CHECK in '2xx', '2xx_3xx'),
is_paused (bool, the only pause flag), pause_reason (null | 'user' |
'blocked_host'), status (CHECK in 'pending', 'up', 'down'; "paused",
"confirming", "blocked" and "unknown" are derived for display, never
stored), config_rev (int, starts at 1), failures, successes,
streak_started_at, streak_first_error, next_check_at, last_checked_at,
lease_id, lease_until, dns_checked_at, created_at.
UNIQUE (id, user_id) (target of composite foreign keys).
Indexes: (user_id); (host); (next_check_at) WHERE is_paused = false.
Method is always GET and timeout always 10 s, so neither is a column.

**check_attempts** (one row per dispatched job)
attempt_id (uuid PK), monitor_id, config_rev, expected_status (snapshot),
state ('claimed' | 'done' | 'dropped' | 'expired'), claimed_at, expires_at.
Deleted 1 day after leaving 'claimed'.

**checks** (30-day retention)
id (bigserial), attempt_id (uuid, UNIQUE), monitor_id, config_rev,
checked_at, ok, status_code, response_ms, error_type (null | 'dns' |
'timeout' | 'tls' | 'connect' | 'bad_status' | 'blocked' | 'other'),
redirect_count.
Index (monitor_id, checked_at DESC). `ok` is computed by the server from the
attempt's snapshot, never taken from the Worker.

**monitor_events**
id, monitor_id, kind ('created' | 'paused' | 'resumed' | 'config_changed' |
'blocked'), at. Used to compute paused spans.

**incidents**
id, monitor_id, started_at (observed onset: first failed check of the
failing streak), confirmed_at, resolved_at (observed recovery onset: first
success of the recovery streak), resolved_confirmed_at, resolved_reason
('recovered' | 'paused' | 'config_changed' | 'blocked'), cause (error_type
of the first failure), created_at.
Partial unique index: (monitor_id) WHERE resolved_at IS NULL, so there is at
most one open incident per monitor. Duration = resolved_at - started_at.
Alerts fire at `confirmed_at` and `resolved_confirmed_at`.

## Alerting tables
**alert_channels**: id, user_id, type ('telegram' | 'webhook' | 'discord' |
'slack'), label, config_enc (envelope `v1.{key_id}.{nonce}.{ciphertext+tag}`),
is_verified, created_at. UNIQUE (id, user_id).

**telegram_link_codes**: code_hash (PK), user_id, expires_at, used_at.

**monitor_alert_channels**: monitor_id, channel_id, user_id. PK (monitor_id,
channel_id). Composite FKs: (monitor_id, user_id) -> monitors (id, user_id)
and (channel_id, user_id) -> alert_channels (id, user_id). The database
therefore refuses to attach another user's monitor or channel.

**alert_outbox** (replaces a per-send event table)
id, incident_id, channel_id, kind ('down' | 'up'), dedupe_key (UNIQUE:
`incident_id:channel_id:kind`), payload (jsonb, no secrets), status
('pending' | 'sending' | 'sent' | 'failed'), attempts, next_attempt_at,
claimed_until, last_error_category (allowlisted), created_at, sent_at.
Rows are created in the same transaction as the incident change. Delivery is
at-least-once (doc 02). A partial index on `(next_attempt_at, id)` covers
pending and sending rows for the retry sweep.

## Public page tables
**status_pages**: id, user_id, slug (UNIQUE on lower(slug), 3 to 40 chars,
lowercase letters, digits, hyphens, reserved words blocked), title,
is_published, created_at. UNIQUE (id, user_id).

**status_page_monitors**: status_page_id, monitor_id, user_id, position,
show_url (default false). PK (status_page_id, monitor_id). Composite FKs:
(status_page_id, user_id) -> status_pages (id, user_id) and (monitor_id,
user_id) -> monitors (id, user_id).

**slug_tombstones**: slug (PK), released_at. A deleted or renamed slug cannot
be claimed by anyone for 30 days.

## Safety and operations tables
- **blocked_hosts**: host (UNIQUE, canonical), include_subdomains (default
  true), reason, created_at.
- **rate_limits**: key, window_start, count. PK (key, window_start). Also
  stores internal request nonces as `nonce:{uuid}` for 120 s.
- **system_heartbeat**: name (PK), last_tick_at, last_claimed, last_ingested.

## Canonical host
Lowercase, strip trailing dot, IDN to punycode, normalise IP literals. A
blocklist entry matches the host itself, and subdomains on a label boundary
when `include_subdomains` is true (`evil.example.com` matches
`example.com`, `notexample.com` does not). Per-hostname caps count the
exact canonical host. Block requests are verified by the maintainer before
adding an entry (reply from an address at that domain, or a token file at
`/.well-known/monitrail-block.txt`). A newly blocked monitor is paused with
reason `blocked_host` on the next claim or maintenance run and its incident
closes as `blocked`.

## Deletion policy (tested)
| Parent deleted | Children |
|---|---|
| user | accounts, sessions, monitors, channels, link codes, status pages (and everything below) |
| monitor | check_attempts, checks, monitor_events, incidents, monitor_alert_channels, status_page_monitors |
| incident | alert_outbox rows |
| alert_channel | monitor_alert_channels, alert_outbox rows |
| status_page | status_page_monitors |
Test: build a fully populated account (monitors, checks, incidents, channels,
outbox rows, pages, in-flight attempts), delete it, and assert zero rows
remain for that user in every table. An in-flight result for a deleted
monitor is dropped, not an error.

## Authorization model
- One role: signed-in user. The system owner is not an app role.
- User DAL (requires `userId`) versus service capabilities (named internal
  functions): see doc 02. Public status queries are a third, read-only path
  selecting only public columns.
- Association mutations check both ends in one transaction and are also
  enforced by the composite foreign keys above.

## Quotas (enforced atomically)
Limits are in doc 02. Every create runs in one transaction that first takes
`pg_advisory_xact_lock(hashtextextended(user_id::text, 0))`, then counts and
inserts. Global and per-host caps also take a global advisory lock. Tests
fire concurrent creates and assert the cap holds.

## Internal API (signed; format in doc 02)
- `POST /api/internal/claim` body `{max: 15}`. Atomically claims due monitors:
  ```sql
  WITH due AS (
    SELECT id FROM monitors
    WHERE is_paused = false AND next_check_at <= now()
      AND (lease_until IS NULL OR lease_until < now())
    ORDER BY next_check_at LIMIT :max
    FOR UPDATE SKIP LOCKED)
  UPDATE monitors m SET lease_id = gen_random_uuid(),
         lease_until = now() + interval '120 seconds'
  FROM due WHERE m.id = due.id RETURNING m.id, m.url, m.config_rev,
         m.expected_status, m.lease_id;
  ```
  then inserts one `check_attempts` row per job, updates `system_heartbeat`,
  schedules the outbox retry sweep after the response, and returns jobs
  plus the blocklist snapshot. Each job includes `due_at` for slot
  lateness measurement. Its lease UUID is also its attempt ID.
- `POST /api/internal/ingest` body `{results: [{attempt_id, monitor_id,
  config_rev, started_at, status_code?, response_ms?, error_type?,
  redirect_count}]}`. One transaction per result; rules in doc 02. Returns
  per attempt `accepted | dropped | error`.
- `POST /api/internal/maintenance` (daily, idempotent): delete checks older
  than 30 days; delete finished or expired attempts older than 1 day; delete
  outbox rows sent more than 90 days ago; delete rate_limit rows older than
  1 day; delete expired link codes; release slug tombstones after 30 days;
  revalidate DNS (public addresses only) for monitors in order of oldest
  `dns_checked_at` within a time budget, pausing offenders; log table sizes.
  Safe to run twice; a missed day is caught up the next day.
- `GET /api/health`: 200 if the heartbeat is under 180 s old and storage is
  under 90% of the plan limit, else 503. No details in the body.
- `POST /api/telegram/webhook`: verifies the secret-token header, handles
  `/start <code>`, nothing else.

## Availability, coverage and latency (the numbers users see)
**Availability % (time-based, per window of 24 h, 7 d or 30 d)**
- Window start = max(now - window, monitor created_at).
- Excluded time is the union of paused spans (from `monitor_events`) and
  unobserved gaps. An interior gap spans two consecutive accepted checks
  more than 3 x the interval apart. Once the monitor is stale, exclude the
  trailing gap from the last accepted check to now. Time before the first
  accepted observation is unobserved. Keep confirmed incident time that
  overlaps an unobserved gap as downtime. Paused time stays excluded.
- Downtime = union of incident intervals from `started_at` to `resolved_at`
  (or now), clipped to the window, minus excluded time.
- Observed = window length - excluded. Coverage = observed / window length.
- Availability = 100 x (1 - downtime / observed). If coverage is below 50%
  or observed is under 1 hour, show "Not enough data".
- Worked examples (30 days = 43,200 min):
  1. One incident of 15 min, no pauses, no gaps: 100 x (1 - 15 / 43,200) =
     99.965%, coverage 100%.
  2. Paused for 10 days, same incident: observed 28,800 min, availability
     99.948%, coverage 66.7%.
  3. Checker dead for 2 days, incident-free: gap excluded, coverage 93.3%,
     availability 100%, and a stale-checker warning is visible.
  4. Checker dead for 20 days: coverage 33.3%, show "Not enough data".
- The daily bar applies the same formula to each UTC day.

**Latency**: average and p95 over successful checks only, using the
measurement definition in doc 02. Chart buckets are in doc 04. Windows up to
30 days are computed directly from `checks`, so no rollup tables exist in v1.

## Storage budget (30-day retention, Supabase Free 500 MB)
At the 40-monitor cap and 5-minute intervals: about 345,600 `checks` rows per
30 days plus confirmation rechecks, roughly 100 to 150 bytes per row
including the index, so on the order of 52 MB before confirmations. Other
tables stay small: outbox rows 90 days, incidents and events 1 year,
attempts 1 day, rate limits 1 day. Phase 10 measures actual table and index
sizes. If the database passes 80% of the plan limit, maintenance logs a
warning; at 90% `/api/health` fails so the external check alerts the owner.
