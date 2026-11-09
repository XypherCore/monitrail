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
The private-DNS and rebinding cases still need a controlled DNS zone.
Fixture lateness is measured from the synthetic due time to check start.

The full batch exceeded the 10 ms Workers Free cron CPU budget. The owner
chose to benchmark smaller batches on Workers Free. Phase 5 stays open
while those runs and the private-DNS proof are pending. The global cap
remains provisional. [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
