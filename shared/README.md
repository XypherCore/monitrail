# Shared modules

## SSRF guard

Import shared static policy and the Worker profile from `ssrf/index.ts`.
`parseTarget` applies the monitor or webhook policy and returns a canonical
URL. `parseWebhookTarget` also checks the approved Slack and Discord URL
forms. `canonicalPolicyHost` produces exact-host policy keys, including one
key for plain and mapped IPv4 addresses.

`prepareBlocklist` compiles a trusted claim snapshot once per batch. Exact
matches always block. An entry with `includeSubdomains` also blocks
descendants on DNS label boundaries. Invalid snapshot entries throw a fixed
error, and invalid candidate names block.

Create a Worker guard with `createWorkerGuard({appUrl, blocklist, fetch})`.
Pass the configured application origin, authenticated blocklist snapshot and
native fetch. `check(url)` returns HTTP status, response-header latency and
redirect count, or an allowlisted error category and redirect count. The
server determines success using the claimed expected-status snapshot.

The Worker profile uses no DNS subrequests. It revalidates static rules and
the blocklist before each target connection, follows at most two redirects,
uses one ten-second deadline and reads at most 64 KiB through a bounded byte
reader. Body cleanup failures preserve the measured final headers. Target
bodies, headers and raw error text never escape the guard.

The Node profile lives under the web application's server-side SSRF module.
It validates DNS at admission and validates the address at connection time
for actual requests. Keep monitored-target and webhook requests inside the
appropriate guard, and pass only application-controlled adapters and policy.

Worker fetch resolves hostnames independently. Static validation cannot
prevent a public-looking target or redirect hostname from resolving
privately. Phase 5 verifies the deployed egress boundary and request budget.
The [Phase 3b report](../docs/phase-3b-delta-report.md) records this gate.
