# Phase 3 verification — SSRF guard

Phase 3 builds the shared security boundary for accepting a monitor URL
and making a guarded check. Work proceeded on `phase/3-ssrf-guard` after
the [Phase 2 gate](phase-2-verification.md) was verified.

The server and Worker entry point, `createMonitoringGuard`, requires a
trusted fetch adapter and an authoritative blocked-host lookup. It fixes
the resolver to Cloudflare DoH. Validation returns a canonical URL
without contacting the monitored host. A check returns only the HTTP
status. The production Worker entry point remains an inert 404. Phase 4
owns the create/edit integration with `blocked_hosts`, and Phase 5 owns
the checker-side policy and fetch integration.

## Done when

The address, DoH and guard tests ran in isolation before integration.
The redirect and body-limit regression tests failed before their
respective fixes. The suite verifies the following rules.

| Rule | Evidence |
| --- | --- |
| Only HTTP(S) and ports 80, 443, 8080, 8443 | Table-driven URL cases include valid cross-scheme port combinations, invalid ports and forbidden schemes. |
| Reject userinfo, local names and single labels | Tests cover empty and encoded userinfo, local suffixes, trailing dots, canonical hostnames and malformed authorities. |
| Reject unsafe IPv4 and IPv6 | Tests cover private, loopback, link-local, CGNAT, multicast, reserved, unique-local and metadata addresses, including IPv4-mapped IPv6, decimal, octal and hex encodings. |
| Resolve A and AAAA and reject any unsafe result | Both queries are issued and a mixed public/private result blocks the target. Empty, malformed, redirected and failed DoH replies fail closed. CNAME traversal is rooted and bounded. |
| Apply the blocked-host policy before each check and redirect | Tests verify canonical policy keys, fresh decisions after validation, denial of a blocked redirect and failure when the lookup throws or returns an invalid decision. |
| Follow at most three redirects manually | Tests reject loopback, metadata, userinfo, forbidden ports, control characters, private DNS changes and a fourth redirect. Same-host hops are revalidated. |
| Share a ten-second deadline | Fake timers cover blocklist, DNS, fetch, redirect chains and body reads, including adapters that ignore abort. Late responses are canceled. |
| Read at most 64 KiB and discard target response data | BYOB reads cannot deliver more than the remaining budget. Workerd measured exactly 65,536 delivered bytes before cancellation and abort. A non-byte stream fails closed. Target bodies and headers are neither returned nor logged. |
| Send an identifiable request without ambient credentials | Tests assert the configured Monitrail User-Agent, clean GET, manual redirect mode, omitted credentials and no cache. Cookies and headers from a redirect are never replayed. |

## Verification

Verified on 2026-11-04 using the existing pinned dependencies. No
dependency versions changed.

| Check | Result |
| --- | --- |
| `npm test` | 96 web tests and 395 SSRF tests passed. |
| `npm run test:runtime --workspace checker` | All four offline tests passed on pinned workerd with compatibility date 2026-10-23. Native fetch used a fixture Worker for DoH and target responses. The harness opened no listening sockets and allowed no external traffic. |
| `npm run build` | Next.js production build and Wrangler dry run passed. |
| `npm run typecheck` and `npm run lint` | Both workspaces and shared code passed. |
| `npm audit --audit-level=low` | The pinned tree reported zero vulnerabilities. |
| Configured credential scan and diff review | The scan found no configured credentials in Git-eligible files or built browser assets. The staged diff passed a targeted credential-pattern scan and environment examples contain names only. Guard tests verify errors and logs omit target data and dependency details. The optional standalone Gitleaks download timed out. |
| Second-model review | Reviewed the changes against docs 01–06. Removed the fallback reader that could receive an oversized chunk and verified native BYOB. The follow-up review found no remaining actionable issues. |

No UI changed, so the 360 px check does not apply.

## Integration limits

- Workers can resolve the target again independently of DoH. Their
  same-zone `resolveOverride` cannot pin arbitrary external targets to a
  vetted IP. DNS rebinding between validation and connection remains
  possible. [Worker Request API](https://developers.cloudflare.com/workers/runtime-apis/request/)
- The 64 KiB cap applies to bytes delivered to the guard's reader. Runtime
  or network buffering can occur before delivery. The native fetch smoke
  uses an offline fixture, with no claim about production egress behavior.
  [Worker BYOB reader](https://developers.cloudflare.com/workers/runtime-apis/streams/readablestreambyobreader/)
- A hostname check typically uses two DoH subrequests and one target
  request per hop. The initial request plus three redirects can use 12
  subrequests without extra CNAME lookups, or up to 36 with the resolver's
  CNAME bounds. Those totals exclude due, ingest and any remote blocklist
  lookup. Phase 5 must size work against the Free plan's 50-subrequest
  invocation limit and measure CPU and connection usage. The documented
  40-check batch ceiling has not been validated as achievable capacity.
  [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- The blocklist is keyed by the canonical requested hostname at each hop.
  A hostname entry does not represent other DNS names sharing the same
  addresses. The IPv6 allowlist follows IANA global-unicast allocations and
  must be reviewed when those allocations change.
  [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry),
  [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry),
  [IANA IPv6 unicast assignments](https://www.iana.org/assignments/ipv6-unicast-address-assignments)
