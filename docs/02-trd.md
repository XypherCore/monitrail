# 02 — TRD: Monitrail

## Stack (defaults; the agent verifies current docs before installing anything)
| Layer | Choice |
|---|---|
| Web app | Next.js (App Router), TypeScript, Tailwind CSS |
| Charts | Recharts (swap only if bundle size becomes a problem) |
| Database | PostgreSQL on Neon (free tier) |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Auth | OAuth (GitHub, Google) via Better Auth, following current Auth.js guidance; see Phase 1 verification |
| Checker | Cloudflare Worker (TypeScript) with Cron Triggers |
| Hosting | Vercel (web), Cloudflare (checker), Neon (DB). Free tiers only in v1 |
| Alerts | Telegram Bot API, generic outgoing webhooks |
| Tests | Vitest for unit tests, Playwright for a small smoke suite |

Why a separate checker: Vercel's free (Hobby) cron is limited to roughly one
run per day, which cannot drive 5-minute checks. A Cloudflare Worker cron
trigger can run every minute. Verify both platforms' current limits before
building (see "Assumptions to verify").

## Architecture
```
Cloudflare Worker (cron, every minute)
  1. GET  {APP_URL}/api/internal/due        -> up to N due monitors
  2. fetch each target in parallel (SSRF-guarded, 10 s timeout)
  3. POST {APP_URL}/api/internal/ingest     -> batch of results
Vercel (Next.js)
  /api/internal/*  verifies HMAC, writes checks, runs the incident state
                   machine, sends alerts, schedules next_check_at
  Dashboard, public status pages, auth
Neon Postgres: the only place state lives. The Worker holds no DB credentials.
```
Subrequest budget per tick: 1 (due) + N (targets) + 1 (ingest). Keep N at 40
or lower. At 40 checks per minute and a 5-minute interval, the free tier
tops out around 200 monitors. Enforce a global monitor cap so the system
never silently falls behind.

## Incident state machine (constants in one file)
```
FAILURE_THRESHOLD = 2, RECOVERY_THRESHOLD = 2
on result:
  ok:   failures = 0; successes += 1
        if status == down and successes >= RECOVERY_THRESHOLD:
            resolve incident, status = up, alert "up"
        else if status in (pending, up): status = up
        next_check_at = now + interval
  fail: successes = 0; failures += 1
        if status != down and failures >= FAILURE_THRESHOLD:
            open incident (one per monitor), status = down, alert "down"
        next_check_at = now + (status == down ? interval : 60 s)
```
Alerts are idempotent: unique (incident_id, channel_id, kind).

## Security requirements (non-negotiable)
**SSRF guard** (one module, used by the web app at creation and by the
checker before every fetch, including every redirect hop):
- Schemes: http and https only. Ports: 80, 443, 8080, 8443 only.
- Reject URLs containing userinfo (user:pass@).
- Reject localhost, *.localhost, *.local, *.internal, and single-label hosts.
- Resolve A and AAAA records (DNS-over-HTTPS) and reject if ANY answer is
  loopback, private, link-local, CGNAT, multicast, reserved, unique-local
  IPv6, or a cloud metadata address (169.254.169.254 and equivalents).
  Handle IPv4-mapped IPv6 and unusual IP encodings (decimal, octal, hex).
- Redirects: follow manually, maximum 3, re-validate each hop.
- Timeout 10 s total. Read at most 64 KB of body, then abort. Never store
  bodies.
- Known limit: a Worker cannot pin the resolved IP, so DNS rebinding is only
  partly mitigated. The guard stays strict anyway, in case the checker ever
  moves to a VPS. Document this in the code.

**Access control**
- Every query goes through a data-access layer that requires a user ID.
  No direct table access from route handlers.
- Automated IDOR tests: user A can never read, edit or delete user B's
  monitors, channels, incidents or status pages.
- Public status pages expose only fields the owner marked public. The
  monitored URL is hidden by default.

**Internal endpoints**
- HMAC-SHA256 over timestamp + body, constant-time comparison, reject if the
  timestamp is more than 60 s off. Secret shared only with the Worker.

**Secrets and data**
- Channel config (Telegram chat ID, webhook URLs) encrypted at rest with
  AES-256-GCM using a key from the environment.
- Never log secrets, tokens or full webhook URLs.
- Security headers: strict CSP, HSTS, X-Content-Type-Options,
  Referrer-Policy, frame-ancestors none.

**Abuse controls**
- Quotas enforced server-side: 10 monitors per user, 5-minute minimum
  interval, global monitor cap, a per-hostname cap across all users.
- Identifiable User-Agent: `Monitrail/1.0 (+{APP_URL}/bot)`.
- `blocked_hosts` table checked at creation and before every check.

## Environment variables (names only; values never committed)
Web: DATABASE_URL, AUTH_SECRET, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET,
AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET, INGEST_HMAC_SECRET, CHANNEL_ENC_KEY,
TELEGRAM_BOT_TOKEN, APP_URL, ABUSE_CONTACT_EMAIL.
Checker: APP_URL, INGEST_HMAC_SECRET.
Maintain a `.env.example` with names and no values.

## Folder structure
```
monitrail/
  AGENTS.md
  docs/                 the six documents
  web/                  Next.js app
  checker/              Cloudflare Worker
  shared/               ssrf guard, hmac, types
```
If importing `shared/` into both builds causes friction, duplicate the small
modules and add a test that fails when the copies differ.

## Constraints
Free tiers only. Fully responsive. No personal identifying information in
the repo, UI, metadata or commit history. No third-party analytics.

## Assumptions to verify before building
- Cloudflare Workers free plan: cron trigger count and granularity, CPU time
  per invocation, and the cap on outbound requests per invocation.
- Vercel Hobby cron frequency.
- Neon free-tier storage and compute limits.
- Current Auth.js status and recommended setup.
