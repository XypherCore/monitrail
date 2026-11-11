# 07 — Decision Log (rev 2)

Records how the second-model review of rev 1 was resolved, so agents do not
reopen settled questions. The owner may change any decision; change the docs
first, then the code.

## Verified facts (Nov 2026) and corrections
- Cloudflare Workers Free: 50 subrequests per invocation, 6 connections
  awaiting headers, 10 ms CPU per cron invocation, 5 cron triggers. Review
  was right.
- Neon Free: 100 CU-hours per project, 0.25 CU minimum, scale-to-zero cannot
  be disabled, **0.5 GB storage per project**. The review said 1 GB; that
  was wrong. Its polling math was right.
- Vercel Hobby is for personal, non-commercial use; cron is about once a
  day. Review was right.
- Phase 5 replaced the provisional cap of 50. The rev 1 estimate of 200
  monitors was withdrawn before benchmarking.
- Border token contrast was 1.36:1; the review was right. Fixed with
  `--border-strong`.

## Adopted
- **Source release**: private during development, open source at deployment
  in Phase 11. Hosted signups remain invite-only through dogfood.
- **Phase 3b**: the owner approved the delta report. Use a fresh disposable
  Supabase target with synthetic fixtures and preserve the existing Neon
  database. The approved report records the auth compatibility and SSRF
  scope gates.
- **SSRF transport**: one guard, two profiles. Web profile validates the
  address at connect time, never follows redirects, fails closed. Slack and
  Discord URLs are host-allowlisted. Worker rebinding risk is documented,
  bounded (status and latency only), and covered by a daily DNS recheck and
  an egress test.
- **IDOR on associations**: composite foreign keys plus same-transaction
  ownership checks; cross-user attach, replace, publish and unlink tests.
- **Duplicate and out-of-order results**: leases, single-use attempt IDs,
  config revisions, per-monitor row locks, server-computed `ok`.
  Phase 5 requires the current unexpired lease. The attempt and lease share
  an ID. Worker start times within the existing clock-skew allowance are
  bounded to the observed lease window.
- **Terminal redirects**: a redirect status without a Location header is
  evaluated as the received 3xx status. Supplied destinations are guarded.
- **Neon polling and capacity**: database moves to Supabase Free by default
  (Neon Launch is the paid fallback); Worker budget math and a benchmark
  replace the old estimate.
- **Exactly-once alerts**: impossible against third parties, so the design is
  an outbox with at-least-once delivery, `event_id` and backoff.
- **Abuse limits**: numbers set, enforced atomically, invite-only signup.
- **Telegram**: one-time-code linking from the destination chat.
- **Public cache**: tagged caching, 60 s maximum staleness, mutation-time
  invalidation, revocation tests that prime the cache first.
- **Signing**: canonical string with method, path, timestamp, nonce, body
  hash.
- **Deletion**: explicit cascade table and a populated-account test.
- **Checker contract**: the claim returns immutable config; the server
  computes `ok`; method and timeout are fixed, not configurable.
- **Free checker scheduling**: the one-minute Cron sends a fixed marker to
  a private Cloudflare Queue. The consumer runs the signed check tick and
  discards markers older than one scheduling interval. The owner selected
  this path after direct Cron exceeded its CPU budget and the disposable
  Queue consumer completed full batches. The integrated staging run and
  database load test support the approved global cap of 40 monitors.
- **Pause, resume, edit semantics**: one `is_paused` flag, `config_rev`,
  explicit incident closure reasons, no recovery alerts on closure.
  Phase 4 owner decisions keep the next scheduled check on interval-only
  edits and require saving a URL that passes validation before resuming a
  blocked monitor. Resume and URL or expected-status changes restart the
  existing 10-minute wait for a first result.
- **OAuth, CSRF, `next`**: provider-ID account identity, no email linking,
  Origin checks, same-origin `next` only.
- **Secrets**: AES-GCM envelope with key IDs and rotation, HTTPS-only
  webhooks, URL masking, allowlisted error categories.
- **Dead checker**: Unknown state, heartbeat, `/api/health`, independent
  GitHub Actions check.
- **Retry timing, first-result journey, incident timestamps**: PRD, flow and
  state machine now agree; observed onset and confirmation are separate.
- **Availability**: time-based, coverage-aware, with worked examples, so a
  dead checker cannot produce a fake 100%.
- **Latency definitions**, bucket sizes and no-data rendering.
- **Maintenance**: idempotent endpoint, defined caller, no rollups needed.
- **Storage**: budget and 90% health failure.
- **Hostname and blocklist semantics**, including redirect hops.
- **Service capabilities** separated from the user DAL.
- **Status-page cardinality, projection, precedence, slug lifecycle.**
- **Alert subscriptions and webhook payload v1.**
- **Schedule**: build and proof are separate milestones; only the owner
  changes scope; missed-check metric is defined.
- **Privacy scope**: applies to the maintainer, not end-user data.

## Modified rather than adopted as written
- Rollups: removed entirely for v1 (30-day raw retention covers every window),
  which also removes the aggregation-lifecycle and percentile-merge issues.
- Per-check DNS lookups in the Worker: not done (they would consume the
  subrequest budget); replaced by web-side validation plus compensating
  controls.

## Remaining owner decisions
1. Database: Supabase Free (default) or Neon Launch (about $19/month at 0.25
   CU always-on, verify).
2. Hosting plan and commercial status (doc 02, "Hosting terms").
3. Open-source license and domain (see doc 01).
