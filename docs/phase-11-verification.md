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
  framework and Node 24 runtime. The domain was verified. Its previous
  private-address DNS record requires replacement with Vercel's recommended
  public address before hosted acceptance.
- Created the private production check queue. The Worker has not yet been
  deployed. Its public and preview endpoints remain disabled in config.
- Added the narrow, tested blocklist administrator capability and private
  evidence exporter. Added a strict offline proof scorer and database-backed
  integration tests for daily and final grace boundaries. Test fixtures are
  synthetic evidence, not dogfood days.
- Added environment-only provider CA support, explicit production settings
  preparation, an upload allowlist excluding administrative credentials,
  and local-source upload exclusions. Independent review findings about
  ambient CA settings, stale secrets and paginated metadata were fixed.

## Open completion checks

- [ ] Production settings uploaded, DNS propagated and HTTPS verified.
- [ ] CI green for the deployment changes and source/history scans clean.
- [ ] Web app and private Worker deployed with matching fresh signing keys.
- [ ] Hosted database TLS, both OAuth providers and real alert delivery verified.
- [ ] Scheduled checker and daily maintenance CPU observed on the Free plan.
- [ ] Independent production health workflow and owner notifications enabled.
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
