# Phase 6 verification

The dashboard shows each monitor’s state, 24-hour availability and coverage,
average response time, and last check. Monitor detail adds three check-history
ranges, average and p95 latency, confirmed incident bands, 30 UTC daily
availability segments, and paginated incident history with closure reasons.
Both pages read through the session-bound data layer. Monitor URLs stay masked.

## Availability examples

The tests generate accepted checks at the documented cadence outside each
pause or outage, then evaluate the same metrics used by the pages.

| 30-day fixture | Coverage | Availability |
| --- | ---: | ---: |
| 15-minute incident | 100% | 99.965% |
| Same incident and a 10-day pause | 66.7% | 99.948% |
| Two-day stale checker, incident-free | 93.3% | 100% |
| Twenty-day stale checker, incident-free | 33.3% | Not enough data |

The coverage and staleness tests also cover the exact age threshold,
observations on window boundaries, overlapping exclusions, confirmed downtime
during gaps, and windows with no checks. Failed checks contribute to coverage.
Only successful measured checks contribute to latency.

## Decisions and scope

- The owner chose to exclude the whole stale trailing gap while preserving
  confirmed downtime. Unknown links to the affected monitor’s check history.
  The dashboard and detail refresh once per minute while the tab is visible.
- Historical gap detection uses the current configured interval, which is the
  cadence the schema retains. The daily bar includes today through the current
  UTC time. The p95 calculation uses linear interpolation.
- Recharts 3.10.1 and its React peer `react-is` 19.3.1 are pinned. The production
  dependency audit reported zero known vulnerabilities at verification time.

## Browser verification

Chromium exercised the production build against an isolated native PostgreSQL 18
database with synthetic accounts. The dashboard and detail fit at 360 px and
1440 px. The browser verified all seven states, the visible-tab transition
from Up to Unknown, all three chart ranges, a chart gap and an incident band,
keyboard selection among 30 UTC days, and incident closure text. Masked URLs
stayed masked. Foreign and missing monitor IDs returned 404. The browser
reported zero console errors and external requests. The synthetic accounts
were removed after verification.

## Regression checks

Build, lint, type checking, 289 web tests, 360 checker tests, six native
workerd tests, and the configured credential scan passed. Owner-scoped database
tests cover foreign and missing monitors, masked URLs, time-window boundaries,
and calculations over more than 100 checks.
An independent model reviewed the availability math, owner-scoped reads,
and presentation against the requirements. No findings remained open.
