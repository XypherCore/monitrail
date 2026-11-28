# Phase 11 verification

Phase 11 is in progress. It covers production deployment, MIT source
release and 14 consecutive clean days of dogfood. The proof period started
on 2026-11-28 at 12:50:21.487 UTC. Zero full days had elapsed at
initialization; the phase is not complete.

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
  production build passed. Keyboard and security journeys against that
  isolated build passed with zero console errors or unexpected external
  requests. The
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
  main at `9bc557b126c053b32fe5a8dc6823a276b83c33cc`, including browser
  journeys against the isolated production build and the storage-budget
  check:
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
  The owner subsequently confirmed failure notifications were already enabled.
- The follow-up diagnostic and getter/Proxy hardening passed full CI on
  main at `78d0e0196bedc5879954410c71f541a869ecb83d`:
  [run 46014990931](https://github.com/XypherCore/monitrail/actions/runs/46014990931).
  Active Worker metadata reported version
  `a70d3d5d-27ec-42b6-aa0d-230ec9ee91e3` at 100% traffic. Version metadata
  alone does not verify daily maintenance CPU.
- The canonical health endpoint again returned 200. Public landing,
  login and bot pages returned 200, fit 360 px, retained the expected
  security headers and produced zero console errors or external requests.
  Protected dashboard access redirected to login; unsigned proof export
  returned 401 and an unauthenticated Telegram callback returned the
  handler's intentional 404. Sign-in CSRF setup returned 200 without
  exposing its token.
- Both public OAuth initiation flows returned 200 and generated the
  expected provider hosts and production callback addresses. Verification
  stopped before navigating to either provider, used no invitation and
  created no account. Authorization URLs, client IDs, cookies and state
  values were not displayed. This verifies initiation, not provider
  consent, callback acceptance or a signed-in session.
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
  were supplied for the existing OAuth apps. The owner saved those settings
  and confirmed GitHub sign-in worked. Reusing that consumed invite for
  Google was rejected as intended. The consumed local invite file was
  removed and one fresh code was generated privately for the Google test,
  with logout and a different-email account required by the provider-based
  identity policy. The owner then confirmed Google sign-in worked and,
  after refreshing Channels, that Telegram was connected and a real test
  alert arrived in the private chat. The silent Start command was expected:
  linking does not send a welcome reply. These are owner-reported live
  acceptance results, distinct from automated OAuth initiation checks.
- Native invocation logging was schema-validated, independently reviewed
  and deployed from clean revision
  `e39e109cfd1be45e1fa637d15d9ef51b2de18134` as Worker version
  `1e23a541-80b8-4a47-a5f1-b67bddef12b1`. Query redaction is enabled,
  request tracing disabled and the existing schedules, Queue and signing
  secret preserved. The pinned dry-run build, lint and all seven native
  runtime checks passed. No application retention or scheduler rule changed.
  The runbook records the Free logging allowance and December 1 pricing
  transition.
- A bounded live tail observed that exact version executing the minute
  Cron and fixed Queue successfully at 14:40:31.369 and 14:40:35.713 UTC
  on 2026-11-27. Only fixed metadata and numeric timing fields were retained;
  raw logs, bodies, URLs and headers were discarded. The stream's timing
  units were not yet verified and it did not contain a daily invocation,
  so daily maintenance CPU remains unverified.
- The owner supplied the two approved monitor detail links after being
  asked to create five-minute monitors and wait for Up. Their private IDs
  were selected through a tested operator option, uploaded to Vercel and
  kept out of source and documentation. Existing production keys were
  preserved. The rebuilt deployment
  `dpl_6jVMiYP4SFyMqfRyzrkXeh1SnJxQ` reached READY with the canonical
  alias and the same application source revision `86a417d`. The public
  security and 360 px checks passed again, including health 200, zero
  console errors and zero unexpected external requests.
- A manual encrypted-capture preflight ran before the rebuild completed
  and failed without uploading an artifact. After the rebuild reached
  READY, [attempt 2 of run 46021660196](https://github.com/XypherCore/monitrail/actions/runs/46021660196/attempts/2)
  successfully captured, encrypted and uploaded the private projection.
  Only the encrypted artifact was downloaded into an owner-only durable
  directory outside the checkout; the encrypted file has mode 0600.
- The reviewed local decryption command then succeeded without loading the
  production environment into the process. The allowlisted snapshot
  matched exactly the two selected monitors, both at revision 1, interval
  300 seconds and unpaused. Each had four accepted checks, its latest
  result healthy; no acceptance evidence was missing and no incident was
  present. The plaintext snapshot also has mode 0600 outside the checkout.
  This verifies collection and decryption, not fourteen days of operation.
- The same preflight exposed cadence drift: mean receipt gaps were 361 and
  362 seconds, with a maximum of 363 seconds for each monitor. Scheduling
  the next check relative to acceptance and polling once per minute adds
  delay. This short sample is not a completed daily score, but it makes the
  strict fixed-slot proof a readiness concern. No scheduling rule or
  measurement threshold was changed; the formal proof remains unstarted
  while the timing rule is reviewed with the owner.
- The owner then explicitly approved the normal scheduling correction:
  advance from the consumed due time along the configured interval grid,
  skipping missed times, while retaining the 60-second acceptance-relative
  confirmation retry. Docs 02 and 07 record the approved rule before its
  implementation. Proof thresholds, quotas and incident thresholds stay
  unchanged.
- Eight new scheduling regression cases were written first. Against the
  old code the ingestion suite had seven failures and fourteen passes.
  The corrected SQL advances the locked row's due time using PostgreSQL
  arithmetic, preserving microseconds and skipping expired grid points.
  The ingestion, claim and state-machine suites then passed all 36 focused
  tests. Independent review found no open correctness or security issues.
  Full regression verification passed 650 web tests, 377 checker/shared
  tests and 22 script tests; the seven native Worker tests also passed,
  1,056 total. Web lint, type checking and whitespace checks passed.
  Live corrected cadence evidence is recorded below.
- Both final isolated builds passed with synthetic configuration. The
  configured-value scan passed across 419 eligible and built browser files,
  the Git index and 66 reachable commits; source/history pattern scans also
  passed. The reviewed changes were fast-forwarded to main without changing
  repository visibility.
- Corrected application revision
  `575a1e2f87e5d167833193239a1d6f27285e90b1` deployed from a clean committed
  archive, excluding local settings and the Git directory, as
  `dpl_Bezx3kEAzYbmX6BbgvFopkWSxtmT`. Read-only metadata confirmed READY,
  production and the canonical alias. Hosted health returned 200 and all
  anonymous security/mobile checks passed again, with zero console errors
  or unexpected external requests. This web-only deployment preserved the
  private Worker and production keys.
- [CI run 46025145706](https://github.com/XypherCore/monitrail/actions/runs/46025145706)
  passed for that exact deployed revision on main, including builds, types,
  application/security suites, native transport, secret scans, dependency
  advisories, browser journeys against the isolated production build and
  the storage-budget check.
- [Fresh preflight run 46026705467](https://github.com/XypherCore/monitrail/actions/runs/46026705467)
  passed after two normal check cycles. Its encrypted artifact was
  downloaded and decrypted into new owner-only files outside the checkout.
  The snapshot captured at 15:38:50.139 UTC matched the approved scope and
  contained two post-deployment accepted results per monitor after
  15:30 UTC. Each monitor's single measured gap rounded to 302 seconds,
  compared with the earlier 361–363-second gaps. Both latest results were
  healthy, revisions remained 1, intervals remained 300 seconds and neither
  monitor was paused. The snapshot had no missing receipts or incidents.
  This short sample validates the deployed correction; it does not
  establish the daily missed-slot threshold or fourteen clean days.
- After the November 27 preflight, source remained private. The common
  proof start and scheduled collection still awaited scheduled maintenance
  CPU evidence. A short cadence sample did not close that gate.
  This manual preflight is not the start of the formal 14-day run.
  Calendar time since deployment does not count as a completed proof run.
- The owner selected the visible login page as the human-trial starting
  point, with the invite already available. Docs 01, 07 and the runbook now
  specify that sign-in, monitor creation and waiting for the first healthy
  result are included. No human trial duration has been recorded yet.
- The owner reported that the hosted cross-account test passed: the Google
  account could not open the GitHub account's two monitors. This is
  owner-reported signed-in browser evidence. The public-page revocation
  test remains open; reaching its slug field does not establish publication
  or revocation. No monitor IDs or account details are recorded here.
- The owner subsequently confirmed that the published test page loaded in
  a private window and immediately showed Not found after unpublishing and
  refreshing that window. This completes the requested hosted
  publish/unpublish revocation check as owner-reported browser evidence.
  The broader mutation/revocation suite remains covered by CI; this manual
  result does not claim every mutation was repeated against the host.

## Launch readiness verified 2026-11-28

- Production health returned 200. The public landing, login and bot pages
  passed the existing 360 px and security-header checks again, with zero
  console errors or unexpected external requests. Protected dashboard
  access redirected, unsigned proof export returned 401, and the Telegram
  callback retained its intentional unauthenticated 404.
- Read-only metadata confirmed production web revision `575a1e2` remained
  READY with the canonical alias and the private Worker still routed 100%
  to version `1e23a541-80b8-4a47-a5f1-b67bddef12b1`.
  [CI run 46029556414](https://github.com/XypherCore/monitrail/actions/runs/46029556414)
  passed on main at `72208fc`; subsequent phase-branch changes were
  documentation only.
- Source/history pattern scans passed. The configured-value scan passed
  across 419 eligible and built browser files, the index and 69 reachable
  commits. These were read-only scans; no secret values were displayed.
- [Readiness capture 46145005202](https://github.com/XypherCore/monitrail/actions/runs/46145005202)
  succeeded and was downloaded/decrypted into new private files outside
  the checkout. At 12:30:50.924 UTC it showed both approved monitors at
  revision 1, interval 300 seconds and unpaused. Since the correction's
  15:30 UTC observation boundary on November 27, each had 252 accepted
  checks, mean gaps of 300 seconds and a maximum gap of 304 seconds. Both
  latest results were healthy. The snapshot had no incidents or missing
  acceptance evidence. This readiness capture is not the formal start.
- A narrow temporary operator helper used documented Wrangler
  authentication only in memory, disabled logs/telemetry and queried only
  this Worker's maintenance window. Three synthetic safety tests and
  independent review covered projection privacy and fail-closed handling
  of missing CPU, duplicate records and incomplete results. Cloudflare's
  stored-log query returned HTTP 403. No raw provider descriptions or
  credentials were displayed, and no independent API CPU result was claimed.
- The owner supplied a successful production Queue record: queue
  `monitrail-check-ticks`, batch size 1, CPU 3 ms and wall time 8,462 ms.
  The excerpt omitted its timestamp/version and does not establish the
  daily Cron's CPU. The owner then supplied the requested daily record:
  `eventType: scheduled`, Cron `17 3 * * *`, expected version
  `1e23a541-80b8-4a47-a5f1-b67bddef12b1`, outcome `ok`, CPU 1 ms and wall
  time 9,082 ms. Its supplied scheduled-time number was `1795835867`.
  Interpreting that number as Unix seconds yields
  `2026-11-28T03:17:47.000Z`, matching the requested window. The seconds
  unit is an inference from magnitude/context, not an independently
  verified API unit. Original and normalized values, owner-reported
  provenance and the separate API 403 are preserved in private evidence.
  An independent second model confirmed this reported invocation meets
  the existing 10 ms daily Cron CPU criterion. It does not establish
  elapsed proof days.
- Deployment acceptance is now recorded. MIT source publication and a
  fresh formal baseline remain to be executed; the proof clock has not
  started at this point. No earlier snapshot will be backdated into the run.

## Source release and proof initialization 2026-11-28

- [Release CI 46145991239](https://github.com/XypherCore/monitrail/actions/runs/46145991239)
  passed at `dd20770a52e953586b64870be7cf68552923987e`. The owner-approved
  [repository](https://github.com/XypherCore/monitrail) was then made public;
  GitHub metadata confirmed PUBLIC visibility and the MIT license. Hosted
  signups remain invite-only. No application redeployment was needed for
  these documentation changes.
- The commit-identity audit found only the project alias, the previously
  approved public brand alias and GitHub's service committer. No history
  rewrite was necessary. All three artifact names present before release
  matched encrypted proof artifacts. GitHub secret scanning and push
  protection were enabled after PUBLIC visibility was verified. These are
  available for public repositories without purchasing a security product.
  [GitHub security availability](https://docs.github.com/en/code-security/getting-started/github-security-features).
- [Formal baseline capture 46146601478](https://github.com/XypherCore/monitrail/actions/runs/46146601478)
  succeeded after deployment acceptance and source publication. Its new
  encrypted artifact and decrypted snapshot were saved outside the checkout
  with owner-only permissions. The approved scope matched, both monitors
  were unpaused at revision 1 and interval 300 seconds, and recent results
  were healthy. No receipts were missing and no incidents were present.
- The common start is that fresh snapshot's database capture time,
  `2026-11-28T12:50:21.487Z` (18:20:21.487 IST). The earlier readiness and
  preflight snapshots do not add elapsed proof days. A reviewed temporary
  initializer passed nine synthetic tests, then created a new private
  manifest, empty review journal and initial report in an owner-only
  durable directory. The existing scorer validated the inputs and returned
  `incomplete`, zero completed days and only `proof_period_not_elapsed`.
  No monitor IDs, snapshots or keys were committed.
- The manifest's grace cutoff is `2026-12-12T12:51:21.487Z`
  (18:21:21.487 IST). Final capture coverage and assessment must extend
  strictly beyond that instant. This is an earliest assessment boundary,
  not a promise of passing: fourteen consecutive clean days and incident
  reviews are still required.
- GitHub metadata confirmed `DOGFOOD_ENABLED=true` and the canonical
  APP_URL. The existing encrypted workflow is enabled for 02:43 and
  14:43 UTC (08:13 and 20:13 IST), with 30-day encrypted artifact retention.
  The secret values were neither returned nor changed. The proof key
  remains local and in GitHub, and database credentials stay out of GitHub.
- [First post-start capture 46147132399](https://github.com/XypherCore/monitrail/actions/runs/46147132399)
  succeeded after the first slot's grace boundary. It was downloaded and
  decrypted into new private files. Assessment at
  `2026-11-28T12:56:57.660Z` used the saved manifest and both verified
  snapshots. Each monitor had one mature expected slot and one received
  check, with zero missed or excluded slots; fleet totals were two
  expected and two received. There were no missing receipts or incidents.
  The report correctly remained `incomplete`, zero completed days, with
  only `proof_period_not_elapsed`. The first full day cannot mature before
  its own 24-hour-plus-grace cutoff. A private operator index links the
  durable captures and CPU evidence for subsequent assessments.
- The owner needs time to arrange the three distinct human trials. They
  remain open; no trial duration or success has been invented. Proof
  collection continues independently while participants are arranged.

## Open completion checks

- [x] Production settings uploaded, DNS propagated and HTTPS verified.
- [x] CI green for the deployment changes and source/history scans clean.
- [x] Web app and private Worker deployed with matching fresh signing keys.
- [x] Hosted database TLS, both OAuth providers and real alert delivery verified.
- [x] Approved cadence correction deployed and short live timing sample verified.
- [x] Hosted signed-in cross-account denial verified (owner reported).
- [x] Hosted public-page publish/unpublish revocation verified (owner reported).
- [x] Production checker Queue CPU observed (owner-reported 3 ms).
- [x] Daily maintenance meets the Free Cron CPU budget (owner-reported 1 ms).
- [x] Independent production health workflow enabled and verified.
- [x] Owner failure notifications enabled (owner confirmed).
- [x] Source released under MIT after deployment acceptance.
- [x] Two approved dogfood monitors and manual encrypted capture/decryption verified.
- [x] Common proof start recorded and scheduled evidence collection enabled.
- [ ] Fourteen real consecutive clean days, all incidents reviewed and missed
  slots below the approved daily thresholds.
- [ ] Three anonymous first-monitor trials and measured case study recorded.

Operational commands, privacy boundaries and proof limitations are in the
[Phase 11 runbook](phase-11-runbook.md). Remaining uncertainty includes
daily cadence under the strict fixed-slot rule, the human trials and the
actual 14-day outcome.
The scheduling correction
has explicit owner approval. No quota, application retention, incident
threshold or proof threshold was changed to make the proof easier.
