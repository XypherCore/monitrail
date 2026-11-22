# 06 — Implementation Plan: Monitrail (rev 2)

Build milestone: 4 weeks (phases 0 to 10). Proof milestone: 14 consecutive
clean days after deploy (phase 11). Only the owner may add, cut or reorder
scope. One phase per agent session, one branch per phase:
`phase/<n>-<name>`. A phase is done only when every "Done when" line is
verified and recorded. A second model reviews each phase diff against docs 01
to 05 before merge.

Status legend: [ ] open, [~] in progress, [x] done

## Week 1 — Foundation and security
- [x] **Phase 0: Setup.** Repo, folders per doc 02, `.env.example`, lint,
  typecheck, test runner, git author set to the alias identity, one identity
  config file (brand name, maintainer name, abuse contact, footer text).
  Done when: build, lint, typecheck and an empty test run pass in `web/` and
  `checker/`; no secrets in history; no identity strings outside the config
  file.
- [x] **Phase 1: Database.** Drizzle schema and migrations for every table in
  doc 05 (including composite FKs, partial unique indexes, CHECK constraints
  and cascade rules), seed script.
  Done when: migrations apply to a clean database; the open-incident unique
  index rejects a second open incident; attaching another user's monitor to a
  channel or status page fails at the database level; the deletion test in
  doc 05 passes.
- [x] **Phase 2: Auth and access layers.** OAuth login with database
  sessions, invite gate, protected routes, user DAL, service-capability
  skeletons, Origin checks, validated `next` parameter.
  Done when: unauthenticated requests redirect correctly; `next` rejects
  `//`, backslashes and schemes; IDOR tests prove user A cannot read, edit,
  delete, attach, replace, publish or unlink user B's rows; a session stops
  working after account deletion.
- [x] **Phase 3: SSRF guard.** Static rules, canonical host, web profile with
  connect-time address validation, checker profile, blocklist matching,
  Slack/Discord host allowlists.
  Done when: the suite covers every rule in doc 02 (private ranges, metadata
  IPs, IPv4-mapped IPv6, odd IP encodings, userinfo, bad ports, DNS errors
  fail closed, redirects to private targets, redirect limits, subdomain block
  matching) and passes.
- [x] **Phase 3b: Align to rev 2 (one-time, only if phases 0 to 3 were built
  from rev 1 docs).** Produce a delta report (built vs docs 02 and 05), get
  owner approval, migrate schema and code, extend the guard.
  Done when: the delta report is empty and all earlier "Done when" lines
  pass again.
  Owner approved the [delta report](phase-3b-delta-report.md).
  The [Phase 3b verification log](phase-3b-verification.md) records the
  repeated foundation checks and live OAuth acceptance.
- [x] **Phase 4: Monitor CRUD.** Create, edit, pause, resume, delete with
  config_rev semantics, atomic quotas (user, global, per-host), blocklist,
  canonical host, rate limits, plain-language rejection reasons.
  Done when: concurrent create tests cannot exceed any cap; pause, resume
  and edit follow doc 02 exactly (incident closure reasons, counters, no
  recovery alerts); empty and pending states render.
  See the [Phase 4 verification log](phase-4-verification.md).

## Week 2 — Checking and dashboard
- [x] **Phase 5: Checker, claim and ingest.** Worker Cron, private check
  queue, signed requests (canonical string, nonce, skew), leases, attempts,
  server-side `ok`, state machine with the constants and timing rule in doc 02.
  Done when: unit tests simulate flap, sustained outage, recovery, slow
  responses, duplicate ingest, late results, results after pause or edit,
  and concurrent claims, and match the state machine; bad signatures, stale
  timestamps and reused nonces are rejected; the egress test proves the
  deployed Worker cannot reach `http://169.254.169.254/`, a private address
  or `localhost`; a scheduled benchmark records consumer CPU, subrequests,
  queue delay and slot lateness at 15 jobs and sets the global monitor cap.
  See the [Phase 5 verification log](phase-5-verification.md).
- [x] **Phase 6: Dashboard and detail pages.** All states, availability with
  coverage and "Not enough data", average and p95, buckets and gaps, daily
  bar, incident log with closure reasons.
  Done when: every worked example in doc 05 reproduces exactly from seeded
  data; Unknown appears when checks stop; 360 px layout verified.
  See the [Phase 6 verification log](phase-6-verification.md).

## Week 3 — Alerts and public pages
- [x] **Phase 7: Alerts.** Channels CRUD with the encryption envelope, key
  rotation script, Telegram one-time-code linking, Discord/Slack/webhook
  adapters through the guarded transport, outbox delivery with backoff,
  subscription rules, test-alert rate limits.
  Done when: a forced outage produces one down and one up event per
  subscribed channel; replaying ingest creates no extra outbox rows; a crash
  between send and record yields at most a duplicate carrying the same
  `event_id`; a slow recipient never delays a check; secrets never appear in
  logs; a webhook that redirects or resolves to a private address is refused;
  an unverified Telegram chat receives nothing.
  See the [Phase 7 verification log](phase-7-verification.md).
- [x] **Phase 8: Public status pages.** Projection, status precedence, slug
  rules and tombstones, tagged caching.
  Done when: cache-revocation tests prime the cache, then publish,
  unpublish, rename, hide URL, remove a monitor, delete a monitor and delete
  the account, and each next request reflects the change immediately;
  unpublished and unknown slugs return the same 404; the HTML contains no
  hidden URLs or private fields.
  See the [Phase 8 verification log](phase-8-verification.md).

## Week 4 — Operations and hardening
- [x] **Phase 9: Maintenance and health.** Daily job (retention, DNS
  revalidation, cleanup), heartbeat, `/api/health`, independent scheduled
  check (GitHub Actions every 15 minutes).
  Done when: running maintenance twice changes nothing the second time;
  stopping the Worker makes `/api/health` fail within 3 minutes and the
  external check report it; monitors that start resolving to private
  addresses are paused.
  See the [Phase 9 verification log](phase-9-verification.md).
- [x] **Phase 10: Hardening and QA.** Security headers and CSP, per-flow
  rate limits, `/bot` page, account deletion, accessibility pass,
  Lighthouse check, CI (lint, typecheck, tests, secret scan), table-size
  measurement against the storage budget.
  Done when: CI is green on main; every security suite passes; a
  keyboard-only run through every journey in doc 03 works; no console
  errors; measured storage is under 60% of the plan limit at the cap.
  See the [Phase 10 verification log](phase-10-verification.md).

## Proof milestone
- [~] **Phase 11: Deploy and dogfood.** Production environment, owner
  decisions on hosting, database and open-source license recorded, public
  source release at deployment, invite-only signups. Monitor
  the Aelvon portfolio and Monitrail itself for 14
  consecutive days.
  Done when: zero false incidents (each incident reviewed by hand); missed
  checks under 1% using the definition in doc 01; a failed day restarts the
  14-day count after the fix; a short case study is written for the
  portfolio.
  See the [Phase 11 verification log](phase-11-verification.md) and
  [deployment and proof runbook](phase-11-runbook.md).

## Definition of done for the project
Every core feature in doc 01 works end to end, the security suites pass in
CI, the dogfood period is clean, and a stranger can create a monitor in
under 2 minutes.
