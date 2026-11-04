# AGENTS.md — Monitrail (rev 2)

## Project
Monitrail is a website uptime and performance monitor (SaaS portfolio
project, brand owner XypherCore). Next.js web app, Cloudflare Worker
checker, PostgreSQL. Read before every task, in this order:
`docs/01-prd.md`, `02-trd.md`, `03-app-flow.md`, `04-ui-ux.md`,
`05-backend-schema.md`, `06-implementation-plan.md`, `07-decision-log.md`.
If your idea conflicts with the docs, the docs win. If the docs are silent,
contradictory or wrong, STOP and ask the owner. Never invent product
decisions, limits, pricing, SLAs, promises or copy. The "Open decisions" in
doc 01 are not yours to answer.

## Working method
- One phase per session, one branch per phase: `phase/<n>-<name>`. One
  commit per logical change with a message stating what and why.
- Do not start a phase until the previous phase's "Done when" lines are
  verified and recorded. Tick a checkbox only after running the check.
- If earlier phases were built from older docs, run Phase 3b first and do
  not continue until its delta report is approved.
- At the end of each phase write a summary: what changed, what you tested,
  what you were unsure about, and every place you deviated from the docs.

## Commands
Verify real scripts in each package.json before running; do not assume.

## Security non-negotiables
1. Never contact a user-supplied URL outside the SSRF guard module: monitor
   targets, webhook tests and every webhook delivery all go through it. No
   direct `fetch(userUrl)` anywhere else. Fail closed on DNS errors.
2. Two access layers, never mixed: the user DAL (always takes `userId` from
   the validated session) and narrow service capabilities for internal work.
   No queries in route handlers. No generic "skip ownership" flag or fake
   user IDs.
3. Association writes verify both ends belong to the same user in the same
   transaction; the composite foreign keys must stay in place.
4. Internal endpoints use the canonical signature (method, path, timestamp,
   nonce, body hash), strict parsing, nonce and skew checks, and `no-store`.
5. Secrets only in environment variables, never committed, logged or echoed.
   Channel configs use the encryption envelope in doc 02 and are never
   returned to the client after creation.
6. Never store response bodies or headers from monitored sites. Store only
   allowlisted error categories, never raw exception text.
7. The checker never decides success: the server computes `ok` from the
   attempt snapshot.
8. Never mark an unreachable or stale monitor as Up. Unknown is a state.
9. Security modules (guard, signing, DAL, state machine, outbox, quotas)
   need tests before the code that depends on them.

## Dependencies and tools
- Before installing any package, check its current documentation and latest
  stable version, pin it, and justify it in the commit message. Prefer
  fewer dependencies.
- Do not install or invoke agent skills, plugins or MCP servers that are not
  already in this project's `.agents` folder. Do not use the 10k-websites
  cinematic skill: this is an application, not a marketing site.

## Identity and privacy
Set git author name and email to the alias identity before the first commit.
Brand name, maintainer name, abuse contact and footer text live in ONE
config file; never hard-code them elsewhere. No real name, personal email,
phone number or location anywhere in code, docs, metadata or history.

## Off-limits without explicit owner approval
Billing or payments, teams, SMS, multi-region checks, an anonymous "check
any site" box, API keys, third-party analytics or trackers, storing bodies,
Telegram groups, rollup tables, changing any quota, threshold, timeout or
state-machine constant, and any product copy that promises response times,
pricing or uptime.

## Definition of done (every task)
1. Build, lint, typecheck and tests pass.
2. The phase's "Done when" lines are verified and recorded.
3. No new console errors; no secrets in the diff.
4. Responsive check at 360 px for any UI change.
5. A second model has reviewed the diff against the docs and its findings
   are resolved or explicitly answered.
