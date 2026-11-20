# Phase 9 verification

Daily maintenance runs through the existing signed internal request boundary.
The Worker invokes it at 03:17 UTC. It removes expired checks, terminal
attempts, sent alerts, rate-limit records, link codes, sessions and slug
reservations. Abandoned attempts are expired before cleanup. Yearly history
cleanup preserves open and recently closed incidents and the event needed
to reconstruct paused time at the retention boundary.

The owner approved pausing on DNS lookup errors and per-host timeouts,
a 45-second batch budget with six concurrent validations, and the yearly
history cleanup rule. Completed DNS validations are checkpointed by UTC
day. Work unfinished at the batch deadline stays due. DNS results are
applied only while the original monitor configuration still matches.

## Completion checks

| Check | Evidence |
| --- | --- |
| Idempotent maintenance | Seeded tests verified retention boundaries and repeated the run. The second run removed zero rows, performed zero DNS validations and left domain rows unchanged. Each signed request still records its own replay nonce. |
| Unsafe DNS | The production HTTPS fixture first returned a public address, then a private address. Daily maintenance paused the monitor, bumped its revision, closed its incident as blocked and updated its public page. Guard tests also covered mixed public/private answers, empty DNS, exceptions and the five-second timeout. |
| Concurrency | Two native PostgreSQL connections validated the same monitor concurrently. Only one blocked transition and event committed. A separate regression changed the monitor during DNS lookup and verified that the old verdict was discarded. |
| Dead checker | The real checker client made a signed idle claim against the production build. Checker updates then stopped. Health stayed 200 immediately before 180 seconds and returned 503 immediately afterward. The independent command reported failure with exit code 1. |
| Health privacy | Healthy and failed responses had empty bodies and no-store headers. Tests covered missing and future heartbeats, storage at the 450,000,000-byte boundary, failed database measurements and redirects. |
| Internal authentication | Maintenance rejected malformed bodies, replayed nonces and signatures for another path. It reused the existing method, body, timestamp, skew and signature checks. Native Worker tests exercised the scheduled caller through real fetch. |

The HTTPS fixture used isolated PostgreSQL 18 and a restricted application
role. Chromium checked the resulting public Blocked and Unknown states and
expandable daily history at 360 px with JavaScript disabled. It reported
zero console errors and external requests. The fixture app, database and
synthetic credentials were removed after testing.

## Security patch

The initial build and npm audit flagged security advisories affecting the
Next.js 16.4.3 pin. Next.js was pinned to the current stable 16.4.6 after
checking the official upgrade documentation, release notes and package
compatibility. The production build, HTTPS test and browser check were
repeated on the patched version. [Release notes](https://github.com/vercel/next.js/releases/tag/v16.4.6).

## Rollout

The health workflow is prepared for a 15-minute schedule on the default
branch. At deployment, configure the repository's APP_URL variable and
Actions failure notifications. Scheduled jobs wait for that URL, and a
manual run with missing configuration fails. Standard public-repository
runners are free. Private-repository jobs use the plan's compute allowance.
GitHub can delay scheduled jobs. [Scheduling](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule),
[billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

Hosted delivery and failure notifications await deployment in Phase 11.
The daily Cron's deployed CPU usage also needs to be checked against the
Free-tier budget during rollout. Local native runtime execution verifies
behavior and transport. An independent model reviewed the implementation,
owner decisions and dependency patch and left no open findings.

## Regression checks

Build, lint, type checking, 378 web tests, 376 checker tests, five independent
probe tests, seven native Worker tests, the configured credential scan and
the Git whitespace check passed. The production dependency audit reported
zero vulnerabilities after the framework patch.
