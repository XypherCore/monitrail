# Phase 3b delta report

Prepared 2026-11-04 for owner approval. The comparison uses the last
verified rev 1 commit, `72c53e4`, and the owner-supplied rev 2
[technical requirements](02-trd.md), [schema](05-backend-schema.md),
[implementation plan](06-implementation-plan.md) and
[decision log](07-decision-log.md). The Phase 4 rev 1 draft is preserved
in Git stash `1b55de43dacf42b5e90af57b262715b200ba637e`.

Phases 0–3 were verified under rev 1. The [Phase 3b gate](06-implementation-plan.md#week-1--foundation-and-security)
requires approval of this report before migration or implementation. Its
exit criteria require resolving the deltas below and rerunning the
updated Phase 0–3 acceptance checks.

## Implementation deltas

| Area | Committed rev 1 evidence | Proposed rev 2 alignment and proof |
| --- | --- | --- |
| Phase 0 identity and environment | The Git alias is set and the environment examples list names only. Brand strings are repeated in the [layout](../web/src/app/layout.tsx), [landing page](../web/src/app/page.tsx), login, icon, auth setup and guard User-Agent. Examples still use `INGEST_HMAC_SECRET`. | Centralize brand, alias, environment-backed abuse contact and footer in one shared config. Read identity from that config in UI, metadata and User-Agent. Update both name inventories for `INTERNAL_HMAC_SECRET` and the applicable rev 2 auth, key and Telegram names. Run identity and secret scans and check the touched UI at 360 px. |
| Phase 1 PostgreSQL provider | [Runtime](../web/src/db/runtime.ts) and [database scripts](../web/scripts/db/connection.ts) require a Neon hostname. The [Phase 1 log](phase-1-verification.md) records a disposable Neon migration. | Support the chosen rev 2 Postgres target. For Supabase, verify TLS and serverless transaction pooling with prepared statements disabled. Use a suitable direct or session connection for administrative migrations. Keep Postgres behind the application access layers and disable the unused Data API on the new target. Verify on a fresh disposable target with synthetic fixtures and least-privilege application access. [Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres) · [Data API controls](https://supabase.com/docs/guides/api/securing-your-api) |
| Phase 1 schema, seed and tests | One [migration](../web/drizzle/0000_phase_1_database.sql) defines 14 rev 1 tables. [Schema tests](../web/src/db/schema.test.ts) cover the old cascade graph, same-owner foreign keys and open-incident uniqueness. | Align the 19 rev 2 domain tables plus any approved compatibility fields. Update the seed and checks for clean migration, exact constraints, same-owner associations and populated-account deletion. Keep the tested partial unique index and composite foreign keys. The schema map below lists each changed area. |
| Phase 2 identity and admission | [Better Auth](../web/src/auth/core.ts) uses database sessions and provider account IDs. It requires a verified email and stores encrypted OAuth access and refresh tokens. The [auth boundary](../web/src/auth/http.ts) has no invite step. | Prove Auth.js compatibility before replacing the adapter. Preserve provider-ID identity, support absent email, give the required message on an existing-email conflict, and persist only provider data required by the framework. Consume a hashed single-use invite atomically with first-account provisioning. Test both providers, concurrent redemption, callback failures, returning users and deleted-user session revocation. |
| Phase 2 request and data boundaries | [Protected requests](../web/src/auth/session.ts) derive ownership from a validated session. The [redirect filter](../web/src/auth/redirect.ts), origin checks and [owner DAL](../web/src/data/access.ts) already cover many rev 2 requirements. The DAL still has a service-like incident method and rev 1 projections for rollups and alert events. The [dashboard](../web/src/app/%28protected%29/dashboard/page.tsx) displays the full monitor URL. | Preserve safe `next`, exact-Origin writes, database sessions, cookie security and redacted errors. Separate named service capability skeletons from the user DAL. Add same-transaction ownership primitives and tests for attach, replace and publish alongside existing read, edit, delete and unlink tests. Mask query strings in rendered monitor URLs, client projections and logs. Verify revocation with a deleted synthetic account and its previous cookie. The settings deletion UI remains Phase 10. |
| Phase 3 static policy and blocklist | [Address rules](../shared/ssrf/address.ts) cover canonicalization and special IP ranges. The [guard](../shared/ssrf/guard.ts) takes a per-host boolean lookup. Rev 1 has no shared label-boundary matcher or `include_subdomains` field. | Reuse the tested static policy. Add separate monitor and webhook URL policies and canonical block matching, including IDNs, root dots, mapped IPs and exact label boundaries. Verify policy checks on initial requests and every Worker redirect. |
| Phase 3 Node profile | [Current composition](../shared/ssrf/index.ts) uses DoH independently of the eventual connection. Its monitor validation performs no target request. It has no connect-time pinning or provider webhook allowlists. | Keep monitor admission DNS-only, subject to approval below. All actual Node requests to supplied URLs use a transport that dials only validated answers, preserves the original Host and TLS SNI and certificate checks, and prevents fallback DNS or proxy bypass. For webhooks, require HTTPS on port 443, exact allowed provider paths, no redirect following, a 5-second deadline and body discard. Test the resolver and socket path with controlled fixtures. [Node HTTPS request options](https://nodejs.org/download/release/v24.12.0/docs/api/https.html#httpsrequestoptions-callback) |
| Phase 3 Worker profile | Rev 1 uses DoH per hop, follows up to three redirects and returns a status after body handling. Its [offline runtime test](../checker/test/ssrf-runtime.ts) proves BYOB support and exercises the rev 1 behavior. The [production Worker](../checker/src/index.ts) is still a 404 scaffold. | Use static rules and the supplied blocklist snapshot with zero DoH subrequests, at most two redirects, a 10-second total deadline and at most 64 KiB delivered to the body reader. Capture header latency across hops before discarding content. A post-header body failure preserves the header result. Return only the bounded measurements and allowlisted error category for ingest. Test no-resolver behavior, redirect limits and post-header errors offline. Phase 5 owns real scheduler, signed claim/ingest, platform egress and capacity checks. |

## Schema map

| Area | Migration delta |
| --- | --- |
| Users, accounts, sessions and invites | Allow nullable email. Convert account identity to the provider/account composite key and sessions to the Auth.js token key and expiry contract. Add unique hashed invites with `used_by ON DELETE SET NULL`; `used_at` still records consumption after user deletion. Retire the Better Auth verification table and move durable rate state to `rate_limits`. |
| Monitors | Store canonical `host` with an index. Enforce the enumerated intervals and `2xx` or `2xx_3xx` in Postgres. Remove configurable method and timeout columns. Add pause reason, configuration revision, streak, lease and DNS validation fields. Use `is_paused` with the three stored base statuses. Derive the other display states. |
| Attempts, checks and events | Add `check_attempts` with a config snapshot and terminal lifecycle, and `monitor_events` for pause spans and changes. Add the unique attempt reference, config revision and redirect count to retained checks. Keep their monitor/time index and cascades. Retire `check_rollups_hourly` and its consumers. |
| Incidents | Add confirmation and closure timestamps and closure reason. Preserve one open incident per monitor, owner isolation and deletion cascades. |
| Alert channels, links and outbox | Add Discord and Slack channel types, the versioned `config_enc` envelope column and `telegram_link_codes`. Replace `alert_events` with leased, deduplicated `alert_outbox` records and allowlisted errors. Preserve composite ownership on subscriptions and across the incident/channel association. Delivery, key rotation and linking remain Phase 7. |
| Status pages and associations | Add slug format and case-insensitive uniqueness and `slug_tombstones`. Retain both composite owner foreign keys, cascades and the default hidden URL. Reserved-word policy, tagged caching and cache revocation belong to Phase 8. |
| Safety and operations | Canonicalize `blocked_hosts` and add `include_subdomains` defaulting to true. Add `rate_limits` and `system_heartbeat`. The nonce protocol, scheduler and operational endpoints remain in their assigned phases. |

## Decisions for approval

1. **Database and existing data.** Use a fresh disposable Supabase
   Postgres project, the documented default, and migrate and seed it with
   synthetic fixtures. Keep the existing Neon database intact. If
   existing users or data must move, approve a separate transfer plan.
   That plan would preserve user UUIDs and provider/account identities,
   rehearse a redacted compatibility check on a disposable copy, and
   require a fresh sign-in after cutover. Legacy tokens, sessions,
   unsupported intervals, incident history and old alert records need
   explicit mappings or disposition before any transfer.
2. **Auth.js compatibility.** Try the stable release path first and
   prove nullable-email OAuth, DB sessions and atomic invites with a
   minimal adapter as needed. The current App Router guide uses a beta
   install command, the upstream latest-release page points to the
   stable v4 line. The adapter contract declares `email: string` and
   `emailVerified` while rev 2 requires nullable email and a smaller
   auth schema. If a supported stable integration cannot pass the proof
   without invented email addresses, excess token retention or extra
   persisted auth fields, return for a decision on a pinned prerelease
   or a spec change. [Auth.js setup](https://authjs.dev/getting-started/installation) · [Latest stable release](https://github.com/nextauthjs/next-auth/releases/latest) · [Adapter contract](https://authjs.dev/reference/core/adapters#adapteruser)
3. **Schema clarifications.** Keep owner columns and composite references
   where needed to prevent cross-user incident/channel associations,
   including the new outbox. Add a terminal timestamp for the one-day
   attempt retention clock. Keep check attempt IDs unique without a
   cascading link to those short-lived rows, so attempt cleanup leaves
   the 30-day check history intact. Doc 05 specifies both retention
   periods and omits the terminal timestamp.
4. **First contact and provider scope.** Validate monitor URLs and DNS
   at admission without contacting the target, as the add-monitor
   journey describes. Apply the Node connect-time guard to any actual
   request. Limit v1 Slack URLs to `hooks.slack.com/services/{team}/{channel}/{token}`
   and Discord URLs to `discord.com/api/webhooks/{id}/{token}`, both
   over HTTPS. Reject other hosts, aliases, path forms and caller-supplied
   query strings for those two adapters. Encode the accepted forms in
   guard tests. [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/) · [Discord execute webhook](https://docs.discord.com/developers/resources/webhook#execute-webhook)

## Verification and remaining gates

- **Baseline verified 2026-11-04.** Both workspace builds, lint and
  typecheck passed. The 96 web tests, 395 SSRF tests and four offline
  workerd tests passed. The configured-credential scan passed. These are
  rev 1 regression results. Rev 2 acceptance remains open.
- **After approval.** Verify pinned dependencies and provider mode
  before any installation. Implement and test the schema and connection
  changes, auth and ownership boundaries, identity and redaction, then
  both guard profiles. Run the updated Phase 0–3 checks, including a
  clean migration, the full cascade graph, live provider sign-in,
  revoked-cookie and 360 px browser checks, and independent diff review.
  Retain and rerun the populated regression suites for Phase 0.
- **Worker egress is a Phase 5 release gate.** With no Worker DNS lookup,
  even a redirect to a public-looking name that always resolves privately
  can evade a static address check. Daily DNS checks of configured targets
  do not cover newly encountered redirect hostnames. Verify the configured
  deployment with controlled direct, redirect and rebinding cases before
  relying on the platform boundary. If it fails, return to the owner for
  a safety or hosting decision. [Workers request resolution](https://developers.cloudflare.com/workers/runtime-apis/request/#the-cf-property)
- **Phase 4 remains gated.** Rebase any useful draft pieces only after
  Phase 3b passes. The draft's interval and expected-status inputs,
  quota environment settings, incident behavior and URL presentation
  differ from rev 2. Later-phase questions about lease ownership after
  reclaim, terminal 3xx handling and availability coverage can be
  resolved in their respective phase gates.
