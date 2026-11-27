# Phase 11 verification

Phase 11 is in progress. It covers production deployment, MIT source
release and 14 consecutive clean days of dogfood. The proof period has
not started and the phase is not complete.

## Owner decisions

On 2026-11-22 the owner approved Vercel Hobby for personal, non-commercial,
unmonetized invite-only testing, Cloudflare Free, a fresh Supabase Free
project, the existing MIT license and `monitrail.duckdns.org`. The owner
excluded the previously proposed client site. Dogfood now covers only the
Aelvon portfolio and Monitrail itself. Docs 01, 06 and 07 record the change.

The owner approved fixed five-minute proof slots, server acceptance times,
one receipt per slot, 60 seconds' grace, per-monitor and fleet daily
missed-slot rates below 1%, paused-slot exclusion and restarts after
configuration changes. The human first-monitor timer stops at the first
healthy result.

## Work and evidence so far

- Created the phase branch and prepared the fixture-free production
  bootstrap. Sixteen focused tests and an isolated PostgreSQL 18 run
  verified migrations, zero seeded data, safe resume checks and restricted
  runtime privileges.
- A secret-file execution guard blocked agent execution before any live
  database work. The owner ran the tested command and reported
  “Production database preparation passed. No application data was seeded.”
  This is owner-reported production evidence. No credentials were shared.
- Created the Vercel Hobby project and verified its `web` root, Next.js
  framework and Node 24 runtime. The owner replaced the domain's previous
  private-address DNS record with Vercel's recommended public address.
  HTTPS and hosted response headers were subsequently verified.
- Created the private production check queue. The tested Worker was
  deployed with both schedules and Queue bindings. Its public and preview
  endpoints remain disabled. Version
  `9322d90b-c03a-452a-9149-4dee96b12046` initially awaited signing-key
  connection; live connection evidence is recorded below.
- The owner reported DNS and OAuth dashboard changes complete and ran the
  reviewed production settings upload successfully. The dedicated proof
  keys were then prepared and uploaded through the same owner-only
  command. GitHub metadata confirmed the two expected secret names without
  returning their values. Hosted sign-in remained an acceptance gate;
  runtime database TLS was subsequently verified through live health.
- Added the narrow, tested blocklist administrator capability and private
  evidence exporter. Added a strict offline proof scorer and database-backed
  integration tests for daily and final grace boundaries. Test fixtures are
  synthetic evidence, not dogfood days.
- Added environment-only provider CA support, explicit production settings
  preparation, an upload allowlist excluding administrative credentials,
  and local-source upload exclusions. Independent review findings about
  ambient CA settings, stale secrets and paginated metadata were fixed.
- The owner approved automatic encrypted proof capture. Added a separately
  signed, read-only endpoint with server-owned monitor IDs/window, a
  strict response projection, AES-GCM encryption before artifact creation
  and a gated twice-daily workflow. The verified upload-artifact v7.0.2
  action is pinned by commit. The database credential never enters GitHub
  and the proof encryption key never enters Vercel.
- Initial local regression checks passed 886 tests, lint, type checking,
  the Worker dry-run build, secret scans and the dependency audit. Further
  signing, registration and encrypted-capture changes are covered by the
  final combined run below.
- The final combined run passed lint, both type checks, 541 web tests,
  377 checker tests, 14 independent probe/crypto/collector tests and seven
  native Worker tests, 939 total. The Worker dry-run bundle and isolated
  production build passed. All production keyboard/security journeys
  passed with zero console errors or unexpected external requests. The
  storage fixture measured 139,474,623 bytes, 27.89% of the plan allowance.
  An independent second model reviewed the full security and workflow
  changes and left no open findings.
- An earlier isolated browser run outlived an unused ten-minute fixture
  session after a long host pause. The fixture now creates fresh current
  and noncurrent sessions immediately before the deletion journey and
  asserts both are active. Product session limits were unchanged. A
  diagnostic full run passed. The subsequent retry copied an unfinished
  module during concurrent work and stopped at build. The final run uses
  the completed source.
- Vercel rejected the first source submission because its current schema
  no longer accepts the documented legacy `public` property. Removed that
  property before retrying. The CLI's source/log privacy defaults remain
  in use. No application timeout or security policy changed for this fix.
- The next Vercel build compiled the application but its web-scoped install
  omitted the repository's TypeScript build tool. The install command now
  explicitly uses the parent root lockfile and includes pinned development
  build dependencies. No dependency versions changed.
- Production web revision `07702a10859562495aa2f9953ed3490cf84cfb8b`
  deployed successfully. Hosted checks verified HTTPS, strict nonce-based
  security headers, protected-route redirects, unsigned export rejection,
  generic unknown-page responses and the 360 px layout, with no browser
  console errors or unexpected external requests. These unauthenticated
  checks do not establish hosted OAuth, database or alert acceptance.
- On 2026-11-23, the production health endpoint returned 503 and the
  Worker's secret-name metadata was empty. Signing-key connection was then
  required. The connection helper's metadata query now preserves JSON
  output while secret uploads continue to suppress output. Focused tests
  and independent review passed. The initial private-file connection
  command required owner execution; no key value was displayed.
- GitHub CI passed for deployed revision `07702a1` and connection-helper
  revision `13bf911`. The latter is recorded in
  [run 45184294694](https://github.com/XypherCore/monitrail/actions/runs/45184294694).
  The source remains private pending the remaining deployment acceptance.
- Added the explicit production invitation command with canonical private
  configuration, ambient-connection conflict checks, hash-only persistence
  and exclusive owner-only output. Tests cover rollback after partial
  writes, close and commit failures without deleting an existing or
  replaced file. Independent review findings were resolved. The first live
  production invite was created during the resumed acceptance below.
- The final 2026-11-23 local verification passed both isolated builds, lint
  and type checking, all 598 web tests, 377 checker tests, 14 independent
  Node tests and seven native Worker tests, 996 total. The final full run
  used the required local-fixture permissions after restricted runs blocked
  child commands and loopback test servers. Source/history pattern scans
  and configured-value scans of source, history and generated browser files
  passed. No product behavior was changed for verification restrictions.
- The owner's combined service-connection command then reported a generic
  failure. Read-only checks confirmed the Worker still had no configured
  key and production health still returned 503. The helper previously
  opened Telegram's database connection before attempting the Worker
  upload, so a failure there could prevent both operations. The helper now
  validates requested local settings first, uploads the checker key before
  opening that connection and reports only allowlisted failure stages and
  confirmed completed operations. It also rejects conflicting ambient CA
  settings. Synthetic regression tests and independent review passed.
  The owner's retry identified the local-settings validation stage, with
  no completed operations. A separately tested and reviewed read-only
  diagnostic mode was approved for agent execution. It reported failures
  only for TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME and
  TELEGRAM_WEBHOOK_SECRET; production-file access, duplicate detection,
  database settings, origin, signing key, CA configuration and trusted
  Worker configuration all passed. The audit made no service calls or
  file changes and revealed no setting values. The owner then corrected
  and uploaded the Telegram settings.
- CI for the production-invitation and staged connection fixes passed on
  main at `9bc557b126c053b32fe5a8dc6823a276b83c33cc`, including production
  browser journeys and the storage-budget check:
  [run 45187872205](https://github.com/XypherCore/monitrail/actions/runs/45187872205).
  The subsequent read-only diagnostic also passed CI at the deployed
  revision recorded below.
- Declared the root package's existing ESM format explicitly. This removes
  the incidental module-format warning for shared TypeScript imports.
  Both workspaces already use ESM and executable JavaScript uses explicit
  `.mjs` files. Independent compatibility review and the 14 Node tests
  passed without that warning.

## Live acceptance verified 2026-11-27

- The owner completed the checker signing-key upload on 2026-11-23.
  Secret-name metadata confirmed the expected binding, and production
  health changed from 503 to 200. The narrow, guarded Telegram-only retry
  then completed successfully without sending a chat message or displaying
  credentials. The earlier registration failure's exact cause was not
  established; no transport rule or timeout was relaxed.
- The production deployment started before the interruption and later
  reached READY as
  `dpl_7zvPHHoHZRdJmgmg4KPzn2tEVpPe`. Read-only Vercel metadata confirmed
  READY, production target, source revision
  `86a417d72c4ebf9c281c7db5e77ec3e839a66bf2` and the canonical domain alias.
  Production Telegram variable names were present before this deployment;
  administrative database credentials, local CA paths and the proof
  encryption key were excluded from the hosted environment.
- [CI run 45190034373](https://github.com/XypherCore/monitrail/actions/runs/45190034373)
  passed for that deployed revision. The approved independent health
  workflow was enabled with the public APP_URL variable and passed its
  [initial run](https://github.com/XypherCore/monitrail/actions/runs/45191481598)
  and [latest observed run](https://github.com/XypherCore/monitrail/actions/runs/45940784153).
  Owner failure-notification preferences remain unverified.
- The canonical health endpoint again returned 200. Public landing,
  login and bot pages returned 200, fit 360 px, retained the expected
  security headers and produced zero console errors or external requests.
  Protected dashboard access redirected to login; unsigned proof export
  returned 401 and an unauthenticated Telegram callback returned the
  handler's intentional 404. Sign-in CSRF setup returned 200 without
  exposing its token.
- Added fixed, allowlisted Telegram guard reasons to operator failures.
  A fresh independent review found that a forged error getter or Proxy
  could escape sanitization. Guarded own-data-property extraction and seven
  adversarial regression tests resolved that finding. Full local checks
  passed both isolated builds, lint, type checking, 622 web tests, 377
  checker tests, 14 independent Node tests and seven native Worker tests:
  1,020 total. Configured-value and source/history secret scans passed.
  No quota, timeout, retention rule or state-machine constant changed.
- The approved invitation command created one production invite using the
  restricted role, storing only the hash in PostgreSQL and the code in the
  ignored owner-only file. No code was displayed. The owner reported that
  provider callbacks still needed the production domain; exact settings
  were supplied for the existing OAuth apps. Both production sign-ins and
  real private-chat alert delivery remain acceptance gates.
- Source remains private. Proof collection remains gated pending the two
  approved monitors, configured export IDs, a verified encrypted capture
  and the common proof start. Calendar time since deployment does not count
  as a completed proof run.

## Open completion checks

- [x] Production settings uploaded, DNS propagated and HTTPS verified.
- [ ] CI green for the deployment changes and source/history scans clean.
- [x] Web app and private Worker deployed with matching fresh signing keys.
- [ ] Hosted database TLS, both OAuth providers and real alert delivery verified.
- [ ] Scheduled checker and daily maintenance CPU observed on the Free plan.
- [x] Independent production health workflow enabled and verified.
- [ ] Owner failure notifications enabled and verified.
- [ ] Source released under MIT after deployment acceptance.
- [ ] Two approved dogfood monitors and private evidence collection started.
- [ ] Fourteen real consecutive clean days, all incidents reviewed and missed
  slots below the approved daily thresholds.
- [ ] Three anonymous first-monitor trials and measured case study recorded.

Operational commands, privacy boundaries and proof limitations are in the
[Phase 11 runbook](phase-11-runbook.md). Remaining uncertainty includes
deployed cadence under the strict fixed-slot rule, hosted integrations and
the actual 14-day outcome. No scheduler, quota, retention or state-machine
constant was changed to make the proof easier.
