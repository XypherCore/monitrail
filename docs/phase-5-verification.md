# Phase 5 verification

Phase 5 runs scheduled checks and records their results. The Worker signs
requests to claim a batch, applies the SSRF guard to each check and redirect,
then submits measured status and timing. The server authenticates requests,
owns the lease and success decisions, and updates the monitor, incident and
outbox in one transaction per accepted observation.

## Implementation and local evidence

| Check | Evidence |
| --- | --- |
| Signed control requests | WebCrypto signs the method, path, timestamp, nonce and body hash. The web endpoint verifies the signature, enforces skew and body limits, consumes the nonce in PostgreSQL, and sends `no-store` responses. Tests reject invalid signatures, stale timestamps and replays. A two-connection PostgreSQL test admitted only one request for a shared nonce. |
| Concurrent claims | A native PostgreSQL 18 probe held two claim transactions at the heartbeat update. Each transaction leased 15 distinct monitors, for 30 leases total. Claim tests also cover order, expiry and reclaim, heartbeat, and pausing blocklisted monitors before dispatch. |
| Result and incident handling | Tests cover flapping, sustained failure, recovery, slow responses, duplicates, stale and expired leases, clock skew and changes during a check. A native concurrent ingest probe produced one check per attempt, one incident, and one outbox row. |
| Worker and database integration | An isolated native PostgreSQL test ran the real signer, endpoint and check services for 15 jobs. A lost ingest response retried with a fresh nonce and left exactly 15 checks. The fixture counted 48 subrequests including the retry. |
| Independent review | Recovery rows now wait for the earlier down delivery instead of being lost when that delivery is late. Ingest transaction errors trigger a single batch retry. Tests cover both changes. |
| Regression checks | Build, lint, typecheck, 269 web tests, 348 checker tests, and six native workerd tests passed. The Wrangler build was a dry run. |

## Decisions and scope

The owner chose to reject expired leases even before reclaim, keep a
redirect status without a Location header as a terminal HTTP response,
and bound small Worker clock differences to the valid lease window.
The existing 60-second skew allowance applies.

The Worker schedules the minute check. Phase 7 delivers outbox entries
and defers recovery delivery until the corresponding down delivery is
recorded as sent. Phase 9 adds the daily maintenance trigger.

## Deployed staging evidence

The temporary Cloudflare checker ran with synthetic jobs, an isolated
fixture Worker and a separate signing secret. The fixture acknowledged only
the expected results. Both staging Workers were removed after the run.

| Staging workload | CPU per tick | Subrequests | Max fixture slot lateness |
| --- | --- | --- | --- |
| 15 checks, each with two redirects and a body larger than 64 KiB | 23 ms, 44 ms | 47 in both runs | 46,610–46,645 ms |
| Six direct and redirected literal egress blocks, plus a public canary | 6 ms, 7 ms | 6 in both runs | 46,528–46,736 ms |

The literal tests rejected metadata, private IPv4 and localhost targets.
Fixture lateness is measured from the synthetic due time to check start.

The full batch exceeded the 10 ms Workers Free cron CPU budget. The owner
chose to stay on Workers Free and benchmark smaller batches.
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

### Smaller batches on 2026-11-09

The follow-up staging run cycled through one to five jobs on the same
two-redirect, over-64-KiB workload. The fixture confirmed every job in the
seven recorded ticks. Cloudflare reported the following CPU samples.

| Jobs | CPU samples | Subrequests | Max fixture slot lateness |
| ---: | --- | ---: | --- |
| 1 | 7 ms, 9 ms | 5 | 54,455–55,059 ms |
| 2 | 11 ms | 8 | 54,730 ms |
| 3 | 11 ms | 11 | 55,247 ms |
| 4 | 24 ms | 14 | 54,677 ms |
| 5 | 20 ms, 22 ms | 17 | 54,553–54,605 ms |

The one-job batch was the only tested size below the 10 ms budget in all
recorded samples. These samples do not establish sustained fleet capacity.
One job per minute provides five normal 5-minute slots before reserving
capacity for confirmation checks. Both temporary Workers were removed.

### Guard optimization and repeat benchmark on 2026-11-09

The Worker now reuses its byte-reader buffer and checks each hostname
against the blocklist once per hop. It still validates every redirect and
cancels the response body at 64 KiB. Independent review found no blocking
issues. Build, lint, typecheck, 269 web tests, 349 checker tests, six native
workerd tests and the credential scan passed.

An isolated Cloudflare deployment repeated the same two-redirect workload
with a 65,537-byte final body. The fixture accepted every expected result.
The table counts unique scheduled ticks and excludes duplicate log events.
Both staging Workers were removed after collection.

| Jobs | CPU samples | Subrequests | Max fixture slot lateness |
| ---: | --- | ---: | --- |
| 1 | 12 ms, 28 ms | 5 | 24,811–24,909 ms |
| 2 | 12 ms, 10 ms | 8 | 24,680–25,112 ms |
| 3 | 10 ms, 11 ms | 11 | 24,810–25,403 ms |
| 15 | 26 ms, 62 ms | 47 | 24,800–25,295 ms |

The two single-job ticks exceeded the 10 ms budget. Every tested size had
at least one sample above the budget. Completed ticks establish successful
execution in staging, with no evidence of a sustainable batch size on the
current Free-tier scheduler. The production batch size and global cap were
left at their documented values pending the capacity decision.

### Deployed private DNS and rebinding test on 2026-11-09

A temporary authenticated Cloudflare Worker ran the production SSRF guard
with the checker's compatibility date and ordinary outbound `fetch`. A
disposable Vercel project served a bodyless public response and a fixed
redirect to the Duck DNS test hostname. A separate public control used the
Vercel alias directly.

The Duck DNS hostname first pointed to the IPv4 address recommended by
Vercel. After the public baseline, the owner switched its A record to
`10.255.255.254`. Two authoritative Duck DNS servers and Cloudflare's
recursive resolver confirmed that private answer with no AAAA record.
The same deployed probe repeated the checks after DNS propagation.

| DNS answer | Direct check | Through the controlled redirect | Separate public control |
| --- | --- | --- | --- |
| Public Vercel IPv4 | HTTP 204, one redirect | HTTP 204, two redirects | HTTP 204 |
| Private IPv4, three runs | HTTP 530, zero redirects | HTTP 530, one redirect | HTTP 204 |

The switch to the private DNS answer produced a repeatable failure
consistent with Cloudflare's documented origin DNS error. The probe
recorded only status codes and redirect counts, so the exact provider error
and connection-level behavior are unconfirmed. This test exercised a DNS
change between checks. [Cloudflare HTTP 530](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-530/)

The temporary Cloudflare Workers and Vercel project were removed after
the test.

### Scheduled CPU diagnostic on 2026-11-09

A disposable Worker ran the current signed checker against a synthetic
fixture. Each captured workload has one unique scheduled sample. The
staging wrapper logged the workload selected by the signed claim
timestamp. The fixture accepted every submitted result.

| Workload | CPU | Subrequests | Max fixture slot lateness |
| --- | ---: | ---: | ---: |
| Empty claim | 2 ms | 1 | — |
| One direct check, bodyless HTTP 204 | 7 ms | 3 | 1,590 ms |
| One check with two redirects, bodyless HTTP 204 | 11 ms | 5 | 1,922 ms |
| One check with two redirects, 65,537-byte body | 7 ms | 5 | 1,766 ms |
| Fifteen checks with two redirects and 65,537-byte bodies | 66 ms | 47 | 1,775 ms |

The interrupted collection retained one sample per workload. The two
temporary Workers were removed when work resumed. These samples show
variation across ticks and are too sparse to isolate the CPU cost of
redirects or body reads. Combined with the earlier 12 ms and 28 ms
single-job runs, the measurements leave the current Free checker without
a verified batch size under its 10 ms CPU budget. Cloudflare can complete
occasional invocations above that limit. [Cloudflare CPU limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

A separate Durable Object trial completed eight test-triggered batches of
15 checks. Each used 47 outbound subrequests. The test trigger called the
object once per batch by design. The object used 36–47 ms of CPU per batch.
The owner chose the existing Cron architecture, and both trial Workers
were removed.

Phase 5 remains open for an owner decision on the checker plan and a
deployed benchmark that supports the global cap. The load model at 15
jobs per minute compared 40 and 50 monitors. Sustained flapping averaged
13.33 jobs per minute at 40 and saturated the scheduler at 50. That model
assumes sufficient CPU for a full batch. It also found that rescheduling
from result acceptance can shift a check or confirmation to a later Cron
tick, so the Phase 11 missed-check metric needs deployed cadence evidence.
