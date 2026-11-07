# Phase 3b verification

Phase 3b aligns the foundation from Phases 0–3 with the revised
specification. The owner approved the [delta report](phase-3b-delta-report.md).
The original Phase 0–3 verification logs document the earlier implementation.

## Scope and implementation

- Shared identity configuration now supplies the web app and checker. URL
  presentation omits query values, and form controls use the stronger border
  token.
- The new PostgreSQL migration adds the revised schema and cascade graph.
  The disposable Supabase project received only synthetic fixture owners,
  paused monitors and unpublished pages. The prior Neon database was preserved.
- Auth.js uses database sessions, provider-account IDs and hashed, single-use
  invitations. Email is optional. OAuth tokens stay out of the database.
  Ownership-sensitive association writes use transactions and composite
  foreign keys. Internal work has separate capability contracts.
- The Node guard resolves and validates addresses at connect time for webhook
  delivery. The Worker guard applies the static address rules and blocklist to
  every redirect and preserves only the permitted check metadata. Its deployed
  egress proof belongs to Phase 5.

## Verification on 2026-11-07

| Check | Evidence |
| --- | --- |
| Hosted clean migration | Both Supabase URLs were verified over TLS with the dashboard CA. The migration ran against a clean application schema and replayed. The synthetic seed ran twice. The first app-role operation failed on a PostgreSQL parameter type. The resumed run matched the committed migration hash and fixture owners before verifying the role and the partial unique incident index. |
| Least-privilege runtime | The transaction pooler authenticated as `monitrail_app` and handled overlapping reads for the two synthetic owners. The runtime rejects admin connection strings. Setup verifies effective DML and sequence privileges, denies schema creation and checks that the Data API roles have no effective privileges on app tables or the checks sequence. Role DDL carries a SCRAM verifier. |
| Unit and integration tests | 174 web tests and 310 checker tests passed. They include clean schema replay, cross-owner foreign keys, full deletion cascades, IDOR, OAuth callback and session security, invite redemption and both SSRF profiles. |
| Worker runtime | Five local workerd tests passed, including byte caps and refusal of unsafe redirects. |
| Build, typecheck and lint | Both workspaces passed. The Worker build was a Wrangler dry run. The working diff passed the whitespace check. |
| Secrets and dependencies | The configured-credential scan covered Git-eligible files, built browser assets, the index and reachable history. The npm audit reported zero advisories. |
| Browser verification | The production build passed over local HTTPS with hosted synthetic fixtures. Verified protected redirects, Secure and HttpOnly session cookies, sanitized session output, owner-only rendering at 360 and 1440 px, no-JavaScript content, and revocation on logout and account deletion. There were no console errors, failed required requests or external browser requests. |
| Second-model review | Reviewed the schema, TLS, role, auth, access and SSRF boundaries. Changes include serialization of competing status-page writes, restricted pooler credentials, reduced role grants, safe process cleanup and a test for spoofed forwarding headers. |

## Compatibility and remaining gates

- Pinned `next-auth@4.24.15` for the stable Auth.js path and
  `postgres@4.0.0` for the TLS-verified Supabase pooler connection. The
  previous auth package was removed from the dependency tree. The
  adapter exposes nullable email at a narrow boundary because the stable
  adapter type expects a string. Loopback integration tests exercise the
  actual OAuth engine and database-session flow with both provider shapes.
  [Auth.js stable releases](https://github.com/nextauthjs/next-auth/releases)
  [Postgres.js releases](https://github.com/porsager/postgres/releases)
- The schema uses the canonical hostname as the blocked-host primary key
  and stores the heartbeat's claimed and ingested counts as nonnegative
  integers. The delta report records the other approved schema clarifications.
- The hosted smoke caught a Drizzle/Postgres.js timestamp serializer
  mismatch. Session writes now use ISO strings with a PostgreSQL timestamp
  cast. The pooler uses unprepared statements and one in-flight query per
  connection. The full browser test passed after these changes.
- Authentication uses a shared admission bucket outside verified Vercel
  ingress. This preserves the previous window and count while rejecting
  untrusted forwarded-address headers. On shared ingress, one client can
  temporarily exhaust that bucket for others.
- Live GitHub and Google consent on this revised stack requires the owner.
  The prior provider sign-ins were on rev 1. Phase 3b remains open while
  this gate is pending.

## Local launcher follow-up

Next.js dev forwarded the Node env-file flag to its server worker in
`NODE_OPTIONS`, where Node rejected it with exit code 9. The dev and start
scripts now load local runtime configuration before invoking the Next CLI.
The migration credential stays with the administrative commands. The
original dev command reproduced the failure, and the updated command
started on loopback and served the login page with HTTP 200.
