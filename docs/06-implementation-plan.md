# 06 — Implementation Plan: Monitrail

Target: 3 weeks. If behind, cut scope, never the date. One phase per agent
session. One branch per phase: `phase/<n>-<name>`. A phase is done only when
every "Done when" line is verified, not assumed. A second model reviews each
phase diff against docs 01 to 05 before merge.

Status legend: [ ] open, [~] in progress, [x] done

## Week 1 — Foundation and security
- [x] **Phase 0: Setup.** Repo, folders per TRD, `.env.example`, lint,
  typecheck, test runner, git author set to the alias identity.
  Done when: `npm run build`, lint, typecheck and an empty test run all pass
  in `web/` and `checker/`; no secrets in git history.
  Verified on 2026-11-01; commands, results, dependency decisions and review
  are recorded in [Phase 0 verification](phase-0-verification.md).
- [x] **Phase 1: Database.** Drizzle schema and migrations for every table in
  doc 05, seed script with fake data.
  Done when: migrations apply to a clean Neon branch, the partial unique
  index on open incidents rejects a second open incident, seed runs.
  Verified on 2026-11-01; clean Neon migration, incident uniqueness, seed,
  general checks and independent review are recorded in
  [Phase 1 verification](phase-1-verification.md).
- [x] **Phase 2: Auth and access layer.** OAuth login, protected routes,
  data-access layer requiring `userId`.
  Done when: unauthenticated requests redirect to `/login?next=`; IDOR tests
  prove user A cannot read, edit or delete user B's rows.
  Verified on 2026-11-02 after Phase 1: protected redirects, IDOR tests,
  both live OAuth providers and security/browser checks; results in
  [Phase 2 status log](phase-2-verification.md).
- [ ] **Phase 3: SSRF guard.** Build and test the guard before ANY code that
  fetches a user URL.
  Done when: the test suite covers every rule in doc 02 (private ranges,
  metadata IPs, IPv4-mapped IPv6, odd IP encodings, userinfo, redirects to
  private targets, bad ports, blocked hosts) and passes.
- [ ] **Phase 4: Monitor CRUD.** Create, edit, pause, delete, with quotas and
  guard validation, plus `blocked_hosts` check.
  Done when: bad URLs are rejected with a plain-language reason, quotas
  enforced server-side (test by calling the API directly), empty and pending
  states render.

## Week 2 — Checking, incidents, alerts
- [ ] **Phase 5: Checker and ingest.** Worker cron, `/due`, `/ingest`, HMAC,
  state machine with the constants from doc 02.
  Done when: unit tests simulate sequences (flap, sustained outage,
  recovery, slow responses) and match the state machine; a bad signature or
  stale timestamp is rejected; a live monitor on a test site updates.
- [ ] **Phase 6: Dashboard and detail pages.** Status, uptime %, avg and p95
  response, chart, incident log.
  Done when: numbers match a hand calculation on seeded data; mobile layout
  verified at 360 px.
- [ ] **Phase 7: Alerts.** Channels CRUD with encryption, Telegram and webhook
  delivery, test-alert button, idempotent `alert_events`.
  Done when: a forced outage sends exactly one down and one up alert per
  channel; retrying ingest does not duplicate; secrets absent from logs.
- [ ] **Phase 8: Public status page.** Cached, minimal, works without JS.
  Done when: unpublished and unknown slugs return the same generic 404; no
  hidden URLs or private fields leak (check the HTML source).

## Week 3 — Hardening and proof
- [ ] **Phase 9: Maintenance job.** Hourly rollups, 30-day retention.
  Done when: rollups equal raw aggregates on seeded data; old rows deleted.
- [ ] **Phase 10: Hardening and QA.** Security headers and CSP, per-hostname
  cap, `/bot` page, account deletion, accessibility pass, Lighthouse check,
  CI that runs lint, typecheck, tests and a secret scan.
  Done when: CI is green on main; all security tests pass; a keyboard-only
  run through every journey in doc 03 works; no console errors.
- [ ] **Phase 11: Deploy and dogfood.** Production environment, monitor
  Jumeirah Fashion, the Aelvon portfolio and Monitrail itself for 14 days.
  Done when: zero false incidents reviewed by hand; checker misses under 1%
  of scheduled checks; a short case study is written for the portfolio.

## Definition of done for the whole project
Every core feature in doc 01 works end to end, security tests pass in CI,
the dogfood period is clean, and a stranger can create a monitor in under 2
minutes.
