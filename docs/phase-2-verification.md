# Phase 2 — authentication and access layer

Date: 2026-11-02. Branch: `phase/2-auth-access`, based on the completed
Phase 1 and phase-history documentation commits. **Complete.** The phase's
required acceptance checks, security regressions and independent review passed.

## Purpose and status log

Phase 2 adds GitHub/Google OAuth, protected application routes and a
data-access layer that requires the authenticated user's ID. It must prevent
one user from reading, editing or deleting another user's data.

- **2026-11-02 — Initial prerequisite audit logged.** The repository contained the
  Phase 1 auth table schema but no auth runtime, protected routes or
  application access layer. At that checkpoint Phase 2 was unchecked and
  no OAuth, login redirect or application IDOR result was claimed.
- **2026-11-02 — Implementation started.** The owner explicitly required
  completing Phase 2 before Phase 3, configured provider credentials locally
  and reported ready. Phase 1's recorded acceptance checks were verified
  before starting. No phase-order gate was skipped.
- **2026-11-02 — Security implementation and local acceptance verified.**
  Auth and access-layer tests preceded their implementations. Both provider
  protocols, database-backed sessions, owner-scoped application access and
  responsive login/workspace screens are implemented. All 96 current tests,
  both workspace builds/typechecks/lint, the development browser acceptance
  and the dependency audit passed. Final production smoke, scans and review
  evidence are recorded below as they complete.
- **2026-11-02 — Live provider sign-in confirmed.** The owner tested both
  Google and GitHub and confirmed that sign-in works. No credentials,
  callback codes or personal account information were included in the log.
- **2026-11-02 — Complete.** Required protected-route and IDOR checks passed,
  along with 96 tests, both builds/typechecks/lint, production HTTPS/browser
  verification, live-provider confirmation, secret scans and independent
  review. Phase 3 remains unchecked and unstarted.

## Changes and security outcome

- Added Better Auth OAuth for GitHub and Google with explicit UUID/table
  mappings to the existing schema. Unverified provider email is rejected
  before provisioning; automatic and manual account linking are disabled.
  A second provider cannot silently claim an existing email identity.
- Access and refresh tokens are encrypted using the framework's supported
  option. Source inspection and tests showed that option does not encrypt
  ID tokens; those are verified in-flight and discarded by persistence hooks.
  Password auth remains disabled and the database's NULL-password constraint
  remains intact. No password, provider-token or account-management API is
  exposed by the HTTP route allowlist.
- Kept signed OAuth state cookies, S256 PKCE, exact origin checks and CSRF
  checks enabled. The auth route rejects arbitrary providers, extra scopes,
  direct ID-token sign-in, external return URLs and oversized sign-in bodies.
  Error payloads and callback error URLs are reduced to generic messages.
- Sessions are validated against the database, with cookie caching disabled.
  Proxy and server rendering read without renewing; the HTTP session endpoint
  forwards refresh/clear cookies while returning only selected user/expiry
  fields. A client renews on mount/navigation without background polling.
  Logout revokes the persisted session. Production origins require HTTPS.
- Added a DAL bound to the validated session user's UUID. Parameterized
  statements include ownership predicates in reads and mutations, including
  both endpoints of associations and parent-owned histories. DTOs omit
  channel ciphertext, tokens and unrelated private fields. Driver errors
  become fixed messages. Internal narrow mutation primitives have no public
  CRUD routes; no monitored URL can be created, changed or fetched yet.
- Added atomic, durable auth throttling using the framework's unchanged
  windows and maxima. HMAC-derived keys and opaque UUIDs are stored as
  anonymous `auth-rate:<digest>` records in the existing verification table.
  Database-clock expiry and a single UPSERT arbitrate competing requests;
  bounded cleanup affects only expired records in that exact namespace.
- The landing page, login and authenticated workspace follow doc 04's
  navigation and accessibility requirements. The dashboard reads actual
  owner-scoped monitors; later CRUD/channel/page-management controls remain
  unavailable. Runtime account information is not hardcoded or committed.
- Secrets remain in ignored local environment storage. A missing high-entropy
  auth secret is generated locally without printing it; file permissions are
  restricted to the owner. Dependency logging and Next development request
  logging are disabled to avoid recording callback codes or raw exceptions.

## Authentication persistence boundary

Pre-login identity/session lookup cannot require an already authenticated
user ID. The server-only auth persistence boundary delegates to the framework
adapter, limited to users, accounts, sessions and verification records.
Namespaced pre-auth limiter records share verification storage. This is a
bounded authentication exception to application DAL ownership, not an
unowned application-query API. Routes delegate to the auth handler and never
query tables directly. Administrative acceptance scripts separately require
explicit fixture opt-in and remove only their temporary synthetic sessions.

## Documentation and dependency verification

Before installation, checked current official documentation and npm stable
metadata. Added exact `better-auth@1.7.15` for the OAuth/session runtime and
`server-only@0.0.1` for server import boundaries. Better Auth's documented
peer ranges accept the existing Next.js, React and stable Drizzle versions.
The lockfile records the complete graph; no auth CLI generator or extra
adapter dependency was installed. The prior esbuild override remains as
documented in [Phase 1](phase-1-verification.md).

References consulted: [installation](https://better-auth.com/docs/installation),
[Next.js integration](https://better-auth.com/docs/integrations/next),
[Drizzle mapping](https://better-auth.com/docs/adapters/drizzle),
[security](https://better-auth.com/docs/reference/security),
[configuration](https://better-auth.com/docs/reference/options),
[account linking](https://better-auth.com/docs/concepts/users-accounts),
[GitHub](https://better-auth.com/docs/authentication/github),
[Google](https://better-auth.com/docs/authentication/google),
[server-only boundaries](https://nextjs.org/docs/app/getting-started/server-and-client-components),
and [development logging](https://nextjs.org/docs/app/api-reference/config/next-config-js/logging).
Also read the installed Next.js guides on auth, Proxy, server/client
boundaries, CLI hostnames and logging. Next dev generated `web/AGENTS.md`;
its instructions were read and retained. No external agent skills, plugins
or MCP servers were installed or invoked; no Ruflo tools were exposed.

## Verification

| Check | Result |
| --- | --- |
| Doc 06: unauthenticated redirects | Passed for dashboard, channels, status pages, settings and monitor paths, preserving safe `next` destinations |
| Doc 06: IDOR reads/edits/deletes | 16 real PostgreSQL/PGlite DAL tests passed with successful owner controls and cross-user rejection |
| Full tests | 96 web tests across 8 files passed; checker intentionally empty suite passed |
| Build, lint, typecheck | Passed in both workspaces; protected pages render dynamically |
| Development browser acceptance | Passed at 360 px and 1440 px with a temporary synthetic-owner session; correct owner data, no overflow, browser errors or external requests; forged cookie rejected and logout deleted session |
| Dependency audit | `npm audit --audit-level=low`: zero vulnerabilities |
| Configured-value secret scan | Passed across Git-eligible source and built browser assets without printing values; local credentials remain ignored |
| Production HTTPS smoke | Passed using the real production build and a temporary local TLS proxy: secure HttpOnly/SameSite cookies, protected redirects, owner data at 360/1440 px, HTML without JavaScript, safe session DTO and logout revocation; temporary test session, key/certificate and processes removed |
| Gitleaks source/history/browser scan | Gitleaks 8.30.1 official release checksum verified; no leaks in Git-eligible files, history or browser assets |
| Second-model review | Auth/DAL/security and helper reviews approved after resolving the findings below; final evidence recorded |
| Real provider consent | Owner confirmed that both Google and GitHub sign-in work; distinct from isolated protocol tests |

Security coverage includes safe return paths/configuration, signed state and
PKCE for both providers, a signed Google identity token, encrypted synthetic
provider tokens, unverified-email and same-email linking rejection, missing/
forged/expired/revoked sessions, cookie renewal, foreign origins, restricted
token APIs, generic errors, pagination, child/link ownership and atomic limiter
contention. The core limiter test receives HTTP 429 on the fourth social
sign-in request under the framework's default three-per-ten-second rule.

Review found and resolved two issues: disabling IP tracking also disabled
the framework limiter, and body-only session reads discarded renewal cookies.
The limiter now remains enabled and persists atomic decisions; read-only
checks and HTTP renewal are tested separately. The CLI test framework budget
now outlasts its existing bounded child-process timeout, avoiding a false
timeout under parallel PostgreSQL test load without weakening assertions.

Helper review also found that a browser cleanup exception could skip fixture
session deletion. Cleanup steps now fail independently with fixed messages,
and both helpers use ten-minute, nonrenewable synthetic sessions. The final
development and production helper executions passed with cleanup complete.

Production checks retain strict failure handling for HTTP, console/page,
required document/asset and auth errors. The final successful run separately
recorded three canceled, same-origin GET/RSC prefetch requests and one script
blocked in the JavaScript-disabled context. The latter's exact `csp` reason
was reproduced in an isolated local fixture without application credentials.
Only those narrow browser-policy cases are exempted; no application failure
was dismissed. The 360 px production screenshot with fake fixture data was
visually inspected; it is temporary and not committed.

## Limits and later phases

- Real provider consent verifies external registration and owner access; the
  isolated provider tests use synthetic responses and keys, never live tokens.
- PGlite concurrent promises verify the atomic SQL contract but do not
  reproduce independent Neon connections. IP throttling also depends on
  trusted client-IP forwarding at deployment; configure and test that trust
  before production. Unknown IP falls back to the framework's shared bucket.
- OAuth state remains short-lived anonymous verification data. Framework
  expiry checks apply; idle orphan cleanup must be included in maintenance.
  Rate-record cleanup runs on later requests and does not claim an idle job.
- Account linking is disabled; signing in with a different provider that
  shares an existing account's email is refused. No account-merging feature
  or email-delivery flow is introduced.
- Phase 3 SSRF protection, Phase 5 HMAC/state machine and Phase 7 channel
  encryption remain unimplemented. No target fetches or unguarded monitor
  mutation handlers were added. Phase 3 has not started.
- Strict CSP/security headers and complete account deletion remain Phase 10;
  scheduled checker/Neon compute decisions remain unresolved for their phase.

See the completed [Phase 0](phase-0-verification.md) and
[Phase 1](phase-1-verification.md) logs for the verified foundation.
