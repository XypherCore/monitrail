# Phase 10 verification

Phase 10 hardens the completed application and makes its verification
repeatable. It adds browser security headers, request budgets, the checker
and abuse page, account deletion, accessibility fixes, production browser
checks, secret scanning, CI and a measured storage fixture. Phase 11
deployment and dogfood have not started.

## Changes and approved decisions

- HTML receives a fresh CSP nonce and a no-store response. Scripts and
  style elements require the nonce. Style attributes remain enabled for
  Recharts. APIs and assets receive a restrictive baseline policy. Tests
  cover hostile incoming nonce/CSP headers, auth redirects and public 404s.
- The owner approved 60 authenticated management writes per hour per user
  and a separate three-attempt account-deletion budget. The existing
  URL-validation, test-alert and Telegram limits also apply. Reservations
  serialize per owner, survive failed mutations and fail closed when
  storage is unavailable. Exhausted budgets return 429 and Retry-After.
- Account deletion requires a validated session, same-origin request and
  explicit confirmation. It deletes the populated account and rate-limit
  keys, revokes every session, expires the browser cookie and immediately
  removes affected public pages. Slug reservations remain in force.
- `/bot` documents the existing checker identity, body-discard policy,
  abuse contact and domain-control proof for block requests. Production
  requires an owner-configured alias in ABUSE_CONTACT_EMAIL.
- Inline links are visibly underlined and wordmarks use their visible
  accessible names. Destructive confirmation dialogs are keyboard usable.
- CI uses pinned action revisions, Node 24.12.0, the lockfile, synthetic
  credentials and a restricted disposable database. Lighthouse 13.6.0 is
  pinned after checking its official documentation, version and Node
  compatibility. Gitleaks 8.30.1 is downloaded with a pinned SHA-256 and
  scans Git-eligible source and all reachable history with redaction.

The owner requested that the repository remain private before pushing
Phase 10. GitHub's API confirmed the visibility change. The existing MIT
license and repository initialization were preserved. Public source
release remains in Phase 11.

## Verification results

| Check | Evidence |
| --- | --- |
| Build, lint and types | Both workspaces passed. The final production browser run rebuilt a separate source copy with synthetic configuration. |
| Security and regression suites | 417 web tests, 376 checker tests, five independent health-probe tests and seven native Worker tests passed, 805 total. Suites include SSRF, IDOR, signing/replay, incident state, outbox, quotas, public-cache revocation and deletion. |
| Concurrent request budgets | Four native PostgreSQL connections admitted exactly 60 of 64 management attempts and three of eight deletion attempts. |
| Keyboard journeys | Landing/sign-in initiation, monitor creation and lifecycle, chart/history controls, outage/recovery, alert-channel management, Telegram linking, status publishing/revocation, logout and account deletion passed over local HTTPS. |
| Browser security and privacy | Two synthetic owners exercised foreign-ID and owner-ID-injection refusal, cross-origin deletion refusal, session revocation and immediate public-page removal. No console errors or unexpected external requests occurred. |
| Responsive and no-JavaScript content | 360 px and desktop checks passed. Public history and expandable daily details also worked with JavaScript disabled. |
| Lighthouse | Seven production routes scored 100 for accessibility and best practices. Performance scores ranged from 87 on monitor detail to 99. No performance threshold was added. |
| Secret and dependency checks | Configured credentials were absent from Git-eligible source, browser assets, the index and reachable history. Redacted source/history scans passed. Production dependency audit reported zero vulnerabilities. |
| Storage | The isolated native PostgreSQL fixture measured 139,703,999 bytes including indexes, 27.94% of the 500,000,000-byte plan allowance and below the required 60%. |
| CI on main | Pending the first push and a successful run for the integrated main commit. Phase 10 remains open until this is verified. |

Lighthouse performance scores were 99 for `/`, 99 for `/bot`, 96 for
`/dashboard`, 99 for `/channels`, 99 for `/status-pages`, 97 for `/settings`
and 87 for monitor detail. Remaining reports include framework/chart
JavaScript and rendering costs. The no-store policy prevents back/forward
cache reuse.

## Storage model

The fixture contains 40 monitors at five-minute intervals, 345,600 scheduled
checks over 30 days and 69,120 confirmation checks, a 20% addition. It also
contains 14,600 incidents over one year, 29,240 monitor events, 21,600
outbox rows over 90 days, 13,840 attempts and representative auth, channel,
page and rate-limit rows. This is a reproducible capacity model, not an
upper bound for every possible incident or retry pattern. No quota,
threshold or retention change was made for the measurement.

The harness uses loopback-only PostgreSQL, a restricted runtime role,
synthetic TLS credentials, fixed guarded target/recipient fixtures and
synthetic sessions. It removes the temporary application, database and
credentials after the run. Safe JSON reports and screenshots remain in
the chosen local report directory.

## Scope, review and deviations

The OAuth browser journey reaches an intercepted provider authorization
page. Live provider consent and callbacks were not repeated here. The
owner previously verified both GitHub and Google sign-in. Telegram's
remote Start action is represented by its authenticated incoming webhook.
The browser exercises generic webhooks, Discord and Telegram. Slack is
covered by its adapter and guarded-transport tests.

An independent second model reviewed the implementation and final
refinements against the specifications and found no remaining actionable
security or CI defects. The two added request budgets are owner-approved
specification updates. The CSP style-attribute allowance supports the
existing chart library and is recorded in doc 02. Production alias
configuration, deployment, remote provider registrations and the 14-day
dogfood period remain Phase 11 work.
