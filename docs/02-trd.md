# 02 — TRD: Monitrail (rev 2)

## Stack (defaults; the agent verifies current docs before installing)
| Layer | Choice |
|---|---|
| Web app | Next.js (App Router), TypeScript, Tailwind CSS |
| Charts | Recharts |
| Database | PostgreSQL on Supabase free plan (default). Fallback: Neon Launch |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Auth | OAuth (GitHub, Google) via Auth.js, database sessions |
| Checker | Cloudflare Worker (TypeScript), Cron Triggers, private Cloudflare Queue |
| Web hosting | Vercel (see "Hosting terms") |
| Alerts | Telegram Bot API, Discord, Slack, generic webhook |
| Tests | Vitest (unit), Playwright (smoke and cache-revocation) |

### Why Supabase, not Neon, for the database
Verified Nov 2026: Neon Free gives 100 CU-hours per project per month, the
minimum compute is 0.25 CU, scale-to-zero after 5 minutes cannot be
disabled, and storage is 0.5 GB. A claim endpoint polled every minute keeps
the compute awake: 0.25 CU x 720 h = 180 CU-hours, exhausting the allowance
in about 17 days, after which compute suspends. Supabase Free has a 500 MB
database, shared CPU, 2 active projects, and pauses projects after 1 week of
inactivity (constant polling counts as activity). It has no CU-hour meter.
Use the pooled connection string from serverless functions. Fallback: Neon
Launch, roughly $19/month at 0.25 CU always-on (verify current pricing).
Never use `/api/health` or the claim endpoint as a reason to rely on the
pause rule; a Supabase pause is a production incident.

## Hosting terms
Vercel Hobby is restricted to personal, non-commercial use, and "commercial"
means any deployment used for anyone's financial gain. Monitrail is invite-
only, unmonetized and a portfolio project, which is the Hobby-friendly
reading, but it also exists to help win paid work. This is the owner's call
(open decision 4). Before public signups, either move to Vercel Pro or to a
host whose free tier explicitly permits commercial use. Vercel Hobby cron is
also limited to about one run per day, so scheduling never uses Vercel cron.

## Architecture
```
Cloudflare Worker, cron every minute
  Enqueue one fixed marker on the private check queue
Same Worker, queue consumer
  1. POST {APP_URL}/api/internal/claim   -> up to 15 leased jobs + blocklist
  2. fetch targets (6 at a time, SSRF-guarded, 10 s timeout)
  3. POST {APP_URL}/api/internal/ingest  -> results
  Daily cron: POST /api/internal/maintenance
Web app (Vercel)
  claim: atomic lease; ingest: serialized state machine + outbox rows
  after ingest: delivers alerts from the outbox (post-response execution)
Postgres: durable application state. The Worker holds no database credentials.
```

The `monitrail-check-ticks` queue carries only a fixed marker. Each batch
contains one message, with zero batching delay, one concurrent consumer,
and zero delivery retries. A marker that has waited at least one scheduling
interval is acknowledged and skipped. Cloudflare can deliver a fresh
marker more than once. PostgreSQL claims and attempt IDs prevent duplicate
results. The checker still retries a failed signed ingest once.

### Worker budget (verified Cloudflare Workers Free, Nov 2026)
50 subrequests per invocation (fetch and bindings both count), 6 outgoing
connections awaiting headers at once, 10 ms CPU per cron invocation (waiting
on I/O is not CPU), 5 cron triggers per account, 100,000 requests/day.
- The Cron invocation makes one queue write. At one marker per minute, normal
  delivery uses about 4,320 of the Free plan's 10,000 queue operations/day
  across sends, reads and deletes. The scheduled benchmark measures actual
  consumer CPU, delivery delay and slot lateness. [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- Per consumer invocation: claim (1) + ingest (1) + target requests. Redirects are followed
  manually, at most 2, so one monitor costs at most 3 subrequests.
- Claim at most 15 monitors per consumer invocation: 2 + 15 x 3 = 47. One ingest retry
  brings the maximum to 48, within the 50-subrequest limit.
- No DNS-over-HTTPS per check in the Worker (it would double the budget).
  DNS is validated in the web app (see SSRF guard).
- The global cap is **40 monitors**. At five-minute intervals these average
  eight scheduled checks per minute before confirmations. The 15-job
  consumer leaves room for confirmations. The load model averaged 13.33
  jobs per minute at 40 under sustained flapping and saturated at 50.
- Direct Cron exceeded 10 ms even for some single-job checks. Phase 5
  verified full batches on the scheduled Queue consumer and exercised the
  real database services with 40 monitors. Phase 11 measures missed
  checks over the dogfood period. [Phase 5 verification](phase-5-verification.md)

## Check leases and attempts
- `claim` atomically selects due, unpaused, unleased monitors with
  `FOR UPDATE SKIP LOCKED`, sets `lease_id` and `lease_until = now + 120 s`,
  and inserts one `check_attempts` row per job (`attempt_id` uuid,
  `monitor_id`, `config_rev`, snapshot of `expected_status`).
- Each job sent to the Worker carries `attempt_id`, `config_rev`, and
  `due_at` for measuring slot lateness.
- The attempt ID is the lease ID. A result needs the monitor's current,
  unexpired lease even when no subsequent claim has run.
- `ingest` processes each result in its own transaction: lock the monitor row
  (`FOR UPDATE`), then accept the result only if the attempt exists and is
  `claimed`, `config_rev` equals the monitor's current value, and the result
  is newer than `last_checked_at`. Invalid observations for a matching
  claimed attempt make it terminal. Its state is `expired` if the lease
  elapsed, or `dropped` otherwise. Replays and mismatched monitor IDs
  leave existing results and other attempts intact. Each attempt is
  accepted at most once.
- The server computes `ok` itself from `status_code`, `error_type` and the
  attempt's `expected_status` snapshot. The Worker does not decide success.
- When the Worker start time is outside the lease's observed time window
  by no more than the existing 60 s clock-skew allowance, record the nearest
  valid time between claim and database receipt. Drop results outside that
  allowance.
- The response lists per attempt: accepted, dropped, or error. The Worker
  retries the same batch once after a failed request or a transaction error.
  A replay cannot change a check that already committed.

## Incident state machine (constants in one file, covered by tests)
```
FAILURE_THRESHOLD = 2, RECOVERY_THRESHOLD = 2, CONFIRM_RETRY = 60 s
on accepted result for monitor M:
  ok:
    failures = 0; successes += 1
    if status == down and successes == 1:
        streak_started_at = checked_at; streak_first_error = null
    if status == down and successes >= RECOVERY_THRESHOLD:
        resolve open incident (resolved_at = streak_started_at,
        resolved_confirmed_at = now, resolved_reason = recovered),
        status = up, streak_started_at = null, enqueue "up" alerts
    else if status in (pending, up): status = up; streak_started_at = null
  fail:
    successes = 0; failures += 1
    if failures == 1: streak_started_at = checked_at; streak_first_error = error_type
    if status != down and failures >= FAILURE_THRESHOLD:
        open incident (started_at = streak_started_at, confirmed_at = now,
        cause = streak_first_error), status = down, enqueue "down" alerts
  unsettled = (status != down and failures > 0) or (status == down and successes > 0)
  next_check_at = now + (unsettled ? CONFIRM_RETRY : interval)
  last_checked_at = checked_at; clear lease
```
Lifecycle changes (all bump `config_rev`, clear the lease, reset counters):
- Pause: `is_paused = true`; open incident closes with reason `paused`; no
  recovery alert. Resume: status `pending`, `next_check_at = now`.
- Edit URL or expected status: status `pending`, open incident closes with
  reason `config_changed`, no recovery alert. The new configuration is due
  immediately and a paused monitor stays paused.
- Blocked host: pause with `pause_reason = blocked_host`, incident closes
  with reason `blocked`. To resume, first save a URL that passes validation.
  This changes the pause reason to `user` and keeps the monitor paused
  until the owner resumes it.
Name and interval edits preserve the existing health state and in-flight
check. An interval-only edit keeps the next scheduled check. The new
interval applies when scheduling subsequent checks.
Results for older `config_rev` are dropped by the rule above.
New monitors are created with `next_check_at = now`.

## Measurement definitions
- Response time = from the start of the request to the arrival of response
  headers, summed over redirect hops. DNS validation time is not included.
- `ok` is decided at the headers. After that the body is read for at most
  64 KB and then cancelled; hitting that cap is not a failure, and a body
  error after the headers never flips `ok`.
- Average and p95 use successful checks only. Failures count toward
  availability and the incident log, never toward latency.

## Security requirements (non-negotiable)

### SSRF guard and guarded transport
One module, two profiles, used wherever the server contacts a URL a user
supplied.
- **Static rules (both)**: http/https only; ports 80, 443, 8080, 8443 for
  monitors and 443 only for webhooks; reject userinfo; reject `localhost`,
  `*.localhost`, `*.local`, `*.internal` and single-label hosts; canonicalize
  the host first (lowercase, strip trailing dot, IDN to punycode, parse
  decimal/octal/hex IP forms); reject private, loopback, link-local, CGNAT,
  multicast, reserved, IPv6 unique-local, IPv4-mapped IPv6 of any of those,
  and cloud metadata addresses (169.254.169.254, fd00:ec2::254).
- **Web profile (webhook test and every delivery, creation-time URL
  checks)**: Node runs the request through an HTTP agent whose connect-time
  `lookup` validates every resolved address and connects only to a validated
  one, so validation and connection use the same IP. Redirects are not
  followed (a 3xx is a failed delivery). Timeout 5 s. The response body is
  discarded. DNS errors fail closed. Slack and Discord channel URLs must
  match their official webhook hosts and paths exactly; only the generic
  webhook type accepts an arbitrary HTTPS host.
- **Checker profile (Worker)**: static rules, the blocklist snapshot from the
  claim response, manual redirects (max 2) with every hop re-validated, 10 s
  total timeout, body cap 64 KB. A redirect status without a Location header
  is a terminal HTTP response. A supplied Location still has to pass the
  redirect rules. A Worker cannot pin the resolved IP.
  `global_fetch_strictly_public` routes same-zone requests through
  Cloudflare's public endpoint, where public routing rules apply.
  [Cloudflare fetch routing](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#global-fetch-strictly-public)
  Compensating controls: (1) DNS is checked in the web app at creation and
  for every monitor by the daily maintenance job (it pauses monitors whose
  hosts now resolve to non-public addresses); (2) the Worker returns only a
  status code, latency and an error category, never content, and holds only
  the HMAC secret; (3) an egress test (phase 5) proves the deployed Worker
  cannot reach `http://169.254.169.254/`, a private address, or `localhost`.
  The residual risk is DNS rebinding between daily checks, limited to blind
  status/latency probing of public hosts. Documented in the code.

### Access control
- Two server-side layers, never mixed:
  1. **User DAL**: every function takes `userId` from the validated session
     and filters by ownership. No direct table access in route handlers.
  2. **Service capabilities** for internal work: `claimChecks`,
     `ingestResults`, `runMaintenance`, `deliverOutbox`, `manageBlocklist`,
     the Telegram webhook handler and the scoped dogfood evidence export.
     Each is a narrow named function reachable
     only from an authenticated entry point (HMAC route, the Telegram
     webhook secret, or an admin CLI script). No generic "skip ownership"
     flag and no fake user IDs.
- Association writes verify both ends belong to the same user in the same
  transaction, and the database enforces it with composite foreign keys
  (doc 05).
- Automated IDOR tests cover read, edit, delete, attach, replace, publish
  and unlink across two users.

### Sessions and requests
- `userId` is derived only from the server-validated session.
- Mutations are POST/PUT/PATCH/DELETE only, check the `Origin` header
  against `APP_URL`, use `SameSite=Lax` cookies, and use the framework's
  CSRF protections where available.
- The `next` parameter must be a same-origin path: starts with a single `/`,
  not `//`, no backslash, no scheme.
- Database sessions, so deleting a user or a session revokes access
  immediately. Test: a session cookie stops working after account deletion.
- Account linking: identify by provider + provider account ID. Never enable
  automatic linking by email. If a second provider returns an email that
  already exists, show "sign in with the provider you used before". Email
  may be missing; the app works without it. Do not persist OAuth access or
  refresh tokens beyond what the library requires.

### Internal request signing
Canonical string: `v1\n{METHOD}\n{PATH}\n{TIMESTAMP}\n{NONCE}\n{HEX_SHA256(body)}`.
Headers `x-monitrail-ts` (integer seconds), `x-monitrail-nonce` (uuid),
`x-monitrail-sig` (hex HMAC-SHA256). Strict parsing, constant-time
comparison, reject skew over 60 s, reject a nonce seen in the last 120 s,
body limit 256 KB, `Cache-Control: no-store` on every internal response.
Empty bodies hash the same way, and the method and path are inside the
signature, so a signature cannot be reused across endpoints.

### Secrets and data
- Channel config is encrypted with AES-256-GCM: a fresh random 12-byte nonce
  per encryption, the 16-byte tag kept with the ciphertext, stored as
  `v1.{key_id}.{nonce}.{ciphertext+tag}` (base64url). Keys come from the
  environment with an ID. Set the previous key and ID during rotation
  so reads can decrypt both versions while the script re-encrypts rows.
- Telegram chat IDs and webhook URLs are never logged and never returned to
  the client after creation (show a masked label).
- Webhook destinations must be HTTPS.
- Monitored URLs may carry credentials in query strings. Show and log them
  with the query string masked; never show the query string on public pages.
- Persist only allowlisted error categories, never raw exception text.
- Security headers: strict CSP, HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`, `frame-ancestors 'none'`.
  HTML is rendered per request with a fresh nonce for scripts and style
  elements and a no-store response. Recharts' style attributes remain
  enabled. APIs and assets receive a restrictive baseline policy.

### Abuse controls and quotas (defaults, enforced atomically)
| Limit | Value |
|---|---|
| Monitors per user | 10 |
| Global monitors | 40 |
| Monitors per hostname across users | 5 |
| Alert channels per user | 3 |
| Status pages per user / monitors per page | 3 / 10 |
| URL validations (create or edit) | 30 per hour per user |
| Test alerts | 5 per hour per user, 3 per hour per channel |
| Telegram link codes | 5 per hour per user, 10 min expiry |
| Minimum interval | 5 minutes |
| Authenticated management writes | 60 per hour per user |
| Account deletion attempts | 3 per hour per user, separate from management writes |
| OAuth initiation | 3 attempts per 10 seconds per trusted ingress-IP bucket |
Counts and inserts run in one transaction behind a per-user advisory lock,
so concurrent requests cannot exceed a limit. Admission: `SIGNUP_MODE=invite`
through the dogfood period; the global cap protects shared capacity after
that. `blocked_hosts` is canonical-host matched (includes subdomains by
default), checked at creation, in `claim`, and for every redirect hop in the
Worker.
Management writes share one budget across monitors, channel management,
test alerts, Telegram link issuance and status pages. The more specific
limits in the table also apply. Authenticated attempts consume the budget
even when validation or the later mutation fails. Account deletion has its
own budget. Responses include `Retry-After` when a budget is exhausted.
The OAuth bucket uses the trusted hosting ingress address when available
and a shared anonymous bucket elsewhere.

### Alert delivery
- Down and up events create `alert_outbox` rows in the same transaction as
  the incident change. Successful signed claims and ingests schedule delivery
  after their response. Try immediately, then back off by 11, 22, 44, 88,
  and 176 minutes, with at most six attempts and a six-hour cutoff.
- Delivery is at-least-once. A crash between "sent" and "recorded" can cause
  a duplicate. A lost acknowledgment can also cause a duplicate. Every
  retry retains the same `event_id` so receivers can deduplicate.
- Slow recipients can never delay checking, because delivery happens after
  the ingest response and is bounded by a 5 s timeout.
- Subscriptions: new monitors default to all verified channels (toggle at
  creation). Removing a channel stops future events; adding one does not
  backfill. A recovery alert goes only to channels that received the down
  alert. If the corresponding down delivery is still pending, defer the
  recovery until the down delivery is recorded as sent. The recovery's
  six-hour cutoff starts when it becomes eligible. Discard the recovery
  if the down delivery fails permanently. Channel labels are editable.
  A new destination requires a new verified channel.
- Generic webhook payload v1: `{ "version": 1, "event": "incident.opened" |
  "incident.resolved", "event_id", "monitor": {"name"}, "incident":
  {"started_at","confirmed_at","resolved_at","cause"}, "sent_at" }`.
  A test sends `{ "version": 1, "event": "alert.test", "event_id", "sent_at" }`.
  Discord and Slack adapters wrap a human-readable line in their own format.

### Telegram linking
User clicks Connect Telegram; the app creates a one-time code (hashed at
rest, 10 min expiry) and shows a `t.me/<bot>?start=<code>` link. The bot
webhook (verified by Telegram's secret-token header) receives `/start
<code>`, binds that private chat to the user, and marks the channel
verified. Reachability alone never verifies a channel. Groups are out of
scope in v1.

### Health, staleness and the public cache
- `claim` updates `system_heartbeat` each tick. `GET /api/health` returns
  200 only if the heartbeat is under 180 s old, otherwise 503, with no
  details. An independent check (GitHub Actions scheduled workflow, every 15
  minutes, failing loudly) calls it. A dead checker must not look like a
  healthy fleet.
- A monitor with no accepted result for 3 x interval displays **Unknown**
  and is excluded from availability as a coverage gap. While waiting for a
  first result, show Pending for up to 10 minutes from creation, resume,
  or the latest URL or expected-status change, then show Unknown.
- Public status requests read publication, monitor membership, current
  status, and URL visibility from PostgreSQL. The response is `no-store`.
  Availability bars and recent incidents use the `status:{slug}` tag and
  have a maximum staleness of 60 s. Every mutation that can change a public
  page (publish, unpublish, slug change, add or remove monitor, `show_url`
  toggle, monitor edit, pause, delete, account deletion) calls
  `revalidateTag` for the affected slugs with immediate expiration after
  commit. Tests prime the history cache, then perform each revocation and
  require the next request to reflect it.

### Privacy scope
"No personal identifying information" applies to the maintainer for now:
repo, UI copy, metadata, commit history, abuse contact (alias address). The
brand owner is XypherCore. When the maintainer identity changes later, only
the single identity config file changes. End-user data (OAuth name, email,
avatar) is collected, stored and shown only to that user.

## Environment variables (names only)
Web: DATABASE_URL, AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET,
AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, INTERNAL_HMAC_SECRET,
CHANNEL_ENC_KEY, CHANNEL_ENC_KEY_ID, CHANNEL_ENC_PREVIOUS_KEY,
CHANNEL_ENC_PREVIOUS_KEY_ID, TELEGRAM_BOT_TOKEN,
TELEGRAM_WEBHOOK_SECRET, TELEGRAM_BOT_USERNAME, APP_URL,
ABUSE_CONTACT_EMAIL, SIGNUP_MODE.
Checker: APP_URL, INTERNAL_HMAC_SECRET.
Keep `.env.example` with names only.

Database administration uses MIGRATION_DATABASE_URL with a direct or
session-pooler connection. Keep it out of the hosted web runtime. The app
uses DATABASE_URL with the transaction pooler. DATABASE_CA_FILE optionally
points to the provider CA when it is needed for TLS verification.
For hosts without that local file, DATABASE_CA_PEM supplies one provider
CA certificate through the environment. Configure one explicit CA source
at a time. Certificate and hostname verification stay enabled.

Optional dogfood capture uses DOGFOOD_EXPORT_HMAC_SECRET and
DOGFOOD_EXPORT_MONITOR_IDS in the web runtime. The dedicated export key
must differ from INTERNAL_HMAC_SECRET. The signed endpoint accepts only
an empty object and exports a database-clock rolling 24-hour projection for
exactly two server-configured monitor IDs. It does not accept IDs or query
windows from a caller. It uses the existing canonical signing, body, skew
and durable nonce checks and no-store responses.

GitHub's proof workflow receives only APP_URL, the dedicated export key
and DOGFOOD_PROOF_KEY. The encryption key is 32 random bytes in canonical
base64url and is never uploaded to Vercel. The collector encrypts snapshots
with AES-256-GCM before artifact creation, with a fresh 12-byte nonce,
16-byte tag and version/key-ID authenticated data. Only encrypted artifacts
are uploaded. Database credentials never enter GitHub. Capture remains
disabled until the two monitors and proof start are configured.

## Folder structure
```
monitrail/  AGENTS.md  docs/  web/  checker/  shared/
```
`shared/` holds the SSRF static rules, HMAC and types. If importing it into
both builds causes friction, duplicate the small modules and add a test that
fails when the copies differ.

## Constraints
Free tiers in v1 (subject to the open decisions on database and hosting).
Responsive. No third-party analytics. Fully testable without production
secrets.

## Still to verify at build time
Auth.js current setup and database-session support; Supabase pooler mode and
connection limits from Vercel; Next.js post-response execution API
(`after`) in the pinned version; Drizzle support for partial unique indexes
and composite foreign keys; the egress test results.
