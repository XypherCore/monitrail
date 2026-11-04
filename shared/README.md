# Shared modules

## SSRF guard

Import `createMonitoringGuard` from `ssrf/index.ts` in server or Worker code.
Pass the native runtime fetch, the application-controlled
`Monitrail/1.0 (+{APP_URL}/bot)` identity and an authoritative
`isBlockedHost(host, { signal })` lookup. Use `canonicalHostname` for hostname
keys in that lookup. A failed lookup or a result other than a boolean blocks
the request. The guard calls the lookup for every requested hostname,
including on each redirect.

- `validate(url)` checks URL policy, the blocklist and both DNS families for a
  hostname. It returns a canonical URL without contacting the target.
- `check(url)` runs those checks again on the initial URL and each redirect.
  It returns only `{ statusCode }`. Failures use a fixed `SsrfError` code and
  message, without the target URL or dependency errors.

The entry point fixes DoH to Cloudflare's DNS JSON endpoint and applies a
shared 10-second deadline and 64 KiB byte-read cap to a check. The lookup
must honor the provided signal. Keep target requests inside the guard and
do not pass user-controlled headers, credentials or fetch adapters to it.

Workers resolve the target again at fetch time. A DNS change between DoH
validation and connection can still permit rebinding. See the
[Phase 3 verification log](../docs/phase-3-verification.md) for evidence and
the request budget that Phase 5 must validate.
