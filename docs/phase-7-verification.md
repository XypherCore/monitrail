# Phase 7 verification

Owners can add and verify Discord, Slack and HTTPS webhook channels, link
a private Telegram chat, rename or delete channels, and choose which
verified channels a monitor uses. New monitors default to all verified
channels. An explicit empty selection disables alerts. Subscription changes
apply to future events. The app never returns a stored destination.

## Delivery and security checks

| Check | Evidence |
| --- | --- |
| Outage and recovery | A forced outage and recovery through check ingest produced one down and one up event per subscribed channel. Replaying the results added no outbox rows. |
| Crash and retry | Losing the database acknowledgment after a successful send produced one retry with the same event ID. Tests covered all five delays, the six-attempt limit, expiry, and fencing of an older delivery after reclaim. |
| Delivery isolation | Signed routes returned while a synthetic recipient was still waiting. In native PostgreSQL 18, a separate connection skipped a locked row. Each row was sent once after the lock was released and the next pass ran. |
| Recovery ordering | Recovery waited for the down delivery. Its deadline started at eligibility. A missing or permanently failed down delivery prevented recovery delivery. |
| Guarded transport | Tests rejected private DNS answers and redirects, and enforced TLS, official Slack and Discord destinations, and the existing five-second timeout. Telegram delivered only to verified private chats through the fixed Bot API. |
| Credential handling | Channel configuration used authenticated AES-256-GCM envelopes bound to the channel, owner and type. Rotation tests covered successful re-encryption and transaction rollback. The credential scan and API tests checked logs and projections for secret exposure. |
| Abuse controls | Tests exercised the shared URL validation budget, the three-channel cap, both test-alert limits, and single-use Telegram codes with expiry and a rolling issuance limit. |

## Decisions and deployment

The owner chose label-only edits, a separate `alert.test` webhook event,
and stable event IDs for uncertain deliveries. Retries wait 11, 22, 44,
88 and 176 minutes, up to a six-hour cutoff. The Queue checker receives
the signed response before the web app runs the bounded delivery pass.
An additive index supports the retry sweep over pending and sending rows.

Provider responses were simulated with fixed synthetic destinations.
Deployment needs an active channel encryption key and Telegram needs a
configured bot and webhook secret. [Alert configuration](../README.md#alert-configuration)

## Browser verification

Authenticated Chromium exercised the production build at 360 px against
isolated PostgreSQL 18. It verified webhook creation and testing, keyboard
rename and deletion, private Telegram linking and replay rejection, and
default and edited monitor subscriptions. It confirmed rejection of foreign
IDs and cross-origin writes. A simulated DNS change to a private address
blocked the test alert before it reached the fixture recipient. The browser
reported zero console errors and external requests. The app, database, and
synthetic credentials were removed after the run.

The first browser run exposed a Next.js request adapter that represented
an empty request as a stream. The fix accepts a zero-byte stream and
rejects unexpected bytes. The regression test and the browser rerun passed.

## Regression checks

Build, lint, type checking, 336 web tests, 360 checker tests, six native
workerd tests and the configured credential scan passed. An independent
model reviewed the delivery, encryption, linking, and ownership boundaries
against the requirements and left no open findings.
