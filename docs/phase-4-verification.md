# Phase 4 verification

Phase 4 lets a signed-in owner create, edit, pause, resume and delete
monitors. Monitor writes use the validated session and exact app Origin.
The dashboard and detail page display masked URLs. A blank replacement
field preserves the stored URL and its query values.

The owner-bound data layer applies the rev 2 intervals and expected-status
choices. It reserves URL validation allowance before calling the shared
guard and checks the authoritative blocklist again before a write.
Transaction locks enforce quotas across owners and requests. Lifecycle
changes record their events and close any applicable incident in the same
transaction.

## Done when

| Check | Evidence |
| --- | --- |
| Concurrent creates respect each cap | On a disposable PostgreSQL 18 instance, two distinct backend connections attempted concurrent creates with one slot left. Each race admitted one write. Totals stopped at 10 per owner, 50 globally and 5 per canonical hostname. A create racing a host-changing edit also stopped at 5. |
| Concurrent URL validation respects the allowance | With one of 30 validations left in the rolling hour, two concurrent requests admitted one DNS resolution. The other request received the retry limit. |
| Pause, resume and edit follow the lifecycle | Database tests verify revision changes, lease and streak resets, new Pending observation, and incident closure with `paused` or `config_changed`. Lifecycle changes do not enqueue recovery alerts. Tests cover the owner-approved blocked-monitor recovery sequence and interval-only scheduling. |
| Empty and Pending states render | Chromium exercised the real app against the disposable Supabase database at 360 px. Synthetic owners verified create, masked URL display, edit, pause, resume, keyboard-confirmed delete, and identical rejection for foreign and missing monitor IDs. The test cleaned up the fixtures. The browser reported no console errors or external requests. |

## Additional checks on 2026-11-08

- The Next.js production build, Wrangler dry run, typecheck, and lint
  passed. The workspace suites passed 223 web tests and 310 checker
  tests. All five workerd smoke tests passed.
- The independent review raised real PostgreSQL concurrency coverage,
  wording for blocked destinations, and the Pending grace period.
  The multi-connection probe, revised message, and owner-approved
  definition address those findings.
- The staged diff passed the whitespace and configured-credential checks.

## Decisions and scope

The owner approved keeping the next scheduled check on interval-only
edits, requiring URL validation before a blocked monitor can resume,
and restarting the existing 10-minute wait after a resume or a URL or
expected-status change. These decisions are recorded in the
[technical requirements](02-trd.md) and [decision log](07-decision-log.md).

The checker will process due monitors in Phase 5. Metrics and charts
belong to Phase 6, and alert subscriptions belong to Phase 7.
