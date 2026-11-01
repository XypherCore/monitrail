# Phase 1 — database schema, migrations and fixtures

Date: 2026-11-01. Branch: `phase/1-database`, based on verified Phase 0
commit `2062c76`. Scope is Phase 1 only. The plan has 12 phases, numbered
0 through 11; no Phase 2 implementation is included here.

## Purpose and completion log

Phase 1 establishes the persisted data model and repeatable migrations, with
fake development data and database integrity checks before application
access is exposed. Ownership foreign keys protect relationships; the later
authenticated access layer must still enforce ownership on every query.

- **2026-11-01 — Complete.** Implementation commit `f8c2f89` on
  `phase/1-database`. Clean Neon migration/replay, rejection of a second open
  incident, final seed execution and idempotency passed. Both workspaces
  passed build, lint and typecheck; all 16 web tests passed. Secret scans,
  production smoke checks and independent review passed, as detailed below.
- **2026-11-02 — Log clarified.** Purpose, completion evidence and security
  boundaries are now explicit. Auth tables are schema only: OAuth, protected
  routes and application IDOR protection remain unimplemented Phase 2 work.
- **2026-11-02 — Repository recheck passed.** Both workspace builds,
  typechecks and lint passed; all 16 existing web tests and the checker's
  intentionally empty suite passed. `npm audit --audit-level=low` reported
  zero vulnerabilities. The documentation changes passed credential-pattern
  and link checks, names-only examples and alias history checks, and a
  second-model review. The original live Neon and browser acceptance checks
  above were not rerun for this documentation-only update. Phase 2 remains
  unstarted and unverified.

## Security outcome at completion

Tests verified ownership constraints, cascading deletion, password-storage
rejection, transactional fixture safety and credential-safe administrative
validation errors. Secret scans and names-only environment examples were
checked. These controls do not establish application IDOR protection,
guarded target fetching, signed internal endpoints or channel encryption;
those require their later phase implementations and security tests.

## Changes

- Added the Drizzle PostgreSQL schema and committed generated SQL, snapshot
  and journal for every domain table in doc 05 plus the documented auth
  tables: 14 application tables in total.
- Preserved the specified 300-second interval minimum/default, 10000 ms
  timeout default and status/error enums. No quota values or thresholds were
  changed or invented. Reserved slug words remain an owner decision before
  page creation is exposed; the DB enforces the specified length/lowercase.
- Added explicit cascades for every owned relationship, including rollups
  and auth ownership. Composite foreign keys with non-null owners prevent
  cross-user monitor/channel links, page/monitor links, incidents and events.
  Partial uniqueness permits at most one unresolved incident per monitor.
- Added nonnegative counters, consistency between paused status and flag,
  incident timestamp ordering, and valid rollup counts. These enforce data
  integrity; the state machine and pause/resume policy remain later work.
- Followed the TRD's current-documentation exception for auth: Auth.js now
  recommends Better Auth for new projects. Added its core table structure,
  UUID IDs and mapped `image` to the specified `avatar_url`. The compatibility
  password column is constrained to NULL; no password authentication or
  password storage is enabled. No auth runtime/adapter package is installed.
- Added owner-controlled administrative migration, seed and acceptance
  commands. Their direct database access is limited to lifecycle/test tools;
  no application database client, route queries or Phase 2 DAL are introduced.
- The opt-in development seed creates only fake reserved-domain users,
  paused monitors, historical checks/rollups, resolved incidents and
  unpublished pages. It preserves existing records, creates no channel/auth
  secrets, and makes no monitored-target requests. IDs are checked against
  expected owners. The first seed's explicit `created_at` is its stable
  history anchor; changing `last_checked_at` cannot duplicate seed samples.

## Current documentation and versions checked before installation

| Package | Exact version | Reason |
| --- | --- | --- |
| drizzle-orm | 0.45.4 | Current stable PostgreSQL ORM/schema; 1.0 is still release-candidate tagged |
| drizzle-kit | 0.31.11 | Current stable schema migration generator/executor matching the stable ORM |
| @neondatabase/serverless | 1.2.0 | Current stable Neon driver; Node 24 has native WebSocket support, so no extra WS package is needed |
| @electric-sql/pglite | 0.5.14 | Test-only real PostgreSQL/WASM engine for credential-free migration and integrity tests |
| esbuild | 0.28.2 | Fixed shared development compiler; prevents old loader/compiler resolution conflicts |

The stable migration tool still includes a deprecated loader requiring
esbuild ~0.18.20 (affected by GHSA-67mh-4wv8-2f99) and its own ^0.25.4 range.
The root's explicit `esbuild: "$esbuild"` override uses the pinned 0.28.2
compiler for all consumers. The lockfile contains only that esbuild version;
clean `npm ci` reports zero vulnerabilities. Generation and migration
execution are checked with the override. npm 11.6.2's `npm ls` diagnostic
still flags the upstream ranges being overridden; it is not recorded as a
passing check. No advisory is suppressed and no `--force` install is used.
Revisit/remove the override when stable Drizzle Kit drops the legacy loader.

Read the official [Drizzle Neon connection guide](https://orm.drizzle.team/docs/get-started/neon-new),
[migration generation](https://orm.drizzle.team/docs/drizzle-kit-generate),
[migration application](https://orm.drizzle.team/docs/drizzle-kit-migrate),
[constraints](https://orm.drizzle.team/docs/indexes-constraints),
[Neon driver](https://neon.com/docs/serverless/serverless-driver),
[PGlite setup](https://pglite.dev/docs/),
[Auth.js recommendation](https://authjs.dev/getting-started/migrate-to-better-auth),
[Better Auth core models and UUIDs](https://better-auth.com/docs/concepts/database),
and [adapter mappings](https://better-auth.com/docs/adapters/drizzle).
Better Auth 1.7.14 was the current stable version checked for this table
contract; runtime installation and OAuth implementation are Phase 2 work.
Node's built-in type stripping and env-file loading avoid adding dotenv/tsx
as direct dependencies. No agent skills/plugins/MCP servers were installed.

## Verification

| Check | Verified result |
| --- | --- |
| Clean `npm ci --no-fund` | Passed; zero reported vulnerabilities, exact lockfile versions |
| `npm run build` | Passed in both workspaces: Next.js production build and Worker dry run |
| `npm run lint` | Passed in both workspaces |
| `npm run typecheck` | Passed in both workspaces, including generated route/Worker types |
| `npm test` | 16 web tests passed: 10 PostgreSQL integrity/seed cases and 6 administrative CLI cases; checker empty suite passed |
| `npm run db:generate --workspace web` | Passed with no schema changes after the committed migration was generated |
| `npm run db:migrate --workspace web` | Passed against the migrated disposable Neon branch with the final compiler override |
| `npm run db:verify-neon --workspace web -- --confirm-clean-branch` | Passed on the initially clean Neon branch; detailed assertions below |
| `npm run db:seed --workspace web -- --confirm-test-data` | Passed with the final seed implementation against the disposable branch |
| `npm run db:verify-neon --workspace web -- --confirm-existing-fixtures` | Passed with the final implementation; 24 checks retained despite changing the last-check clock |
| Production browser/Worker smoke | Passed at 360 px and 1440 px without overflow, console/page errors, failed assets or external requests; core HTML rendered without JavaScript; Worker returned empty 404 |
| Secret scans and identity | Gitleaks found no leaks in all 46 Git-eligible files, built browser assets or Git history; ignored credentials were excluded; environment examples are names-only and all commit identities use the project alias |
| Independent review | Second model approved the final schema, migrations, seed and administrative verification code; both reported seed findings resolved |

The live clean-Neon acceptance command already passed: the public schema was
empty before migration, all 14 tables were created, replaying the committed
migration was safe, a second open incident failed with SQLSTATE 23505,
resolving that incident allowed another to open, and the fake seed ran twice
without creating active monitors. Verification-only incident rows were rolled
back. Credentials stayed in ignored `web/.env.local` and were never printed.

The later existing-fixture check first verified that the branch still held
only the two known fake owners, two paused fake monitors, 24 checks and no
channels. It transactionally aligned only those original fixture anchors,
ran the final seed, changed last-check time by a day, and seeded again.
The check count stayed 24 and the simulated last-check edits were rolled
back. It neither resets the branch nor replaces the clean-branch check.

The reviewer identified two seed edge cases: a mutable history anchor and a
silently skipped incident ID collision. Regression tests reproduced both
failures before the fixes. The anchor now uses explicit `created_at`, and a
conflicting incident UUID aborts and rolls back the complete seed transaction.
The final typecheck also caught an untyped raw timestamp in the acceptance
script; timestamp parsing now narrows the driver value and fails closed on
unsupported values. Typecheck, build and live verification passed afterward.

The CLI tests verify opt-in/production refusal and redaction on connection
validation failures. They do not simulate every remote driver or migration
subprocess failure; raw subprocess output is discarded and command failures
use fixed messages rather than printing dependency exceptions.

## Boundaries and follow-up

- Phase 2 must configure the Better Auth UUID/table mapping, secure OAuth
  identity/linking, token handling and ownership-aware DAL. Anonymous
  pre-account verification records have no user owner; associate ownership
  whenever known and implement expiry cleanup rather than claiming that
  anonymous rows can cascade from an unknown user.
- Channel encryption and delivery are Phase 7 work. Tests use opaque dummy
  bytes only to exercise relational constraints; they do not claim to test
  encryption. The actual seed creates no channels.
- Incident scheduling, attempt leases/deduplication and stale-result handling
  remain Phase 5 work. Alert-event row uniqueness is not an exactly-once
  external delivery guarantee.
- The previously identified Neon continuous-polling compute issue remains
  an owner decision before implementing the continuously running checker.
  Phase 1 uses short administrative sessions on the specified free provider;
  it does not introduce polling, change providers, quotas, billing or limits.
- No UI was changed. The production smoke check nevertheless passed at
  360 px and 1440 px, with no console errors, core HTML without JavaScript
  and the unchanged empty Worker response.
