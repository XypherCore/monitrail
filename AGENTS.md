# AGENTS.md — Monitrail

## Project
Monitrail is a website uptime and performance monitor (SaaS portfolio
project). Next.js web app, Cloudflare Worker checker, Neon Postgres.
Source of truth, read before every task, in this order:
`docs/01-prd.md`, `02-trd.md`, `03-app-flow.md`, `04-ui-ux.md`,
`05-backend-schema.md`, `06-implementation-plan.md`.
If the docs conflict with your idea, the docs win. If the docs are silent or
wrong, stop and ask. Never invent product decisions, pricing, SLAs or
promises. The "Open decisions" in doc 01 are not yours to answer.

## Working method
- Work only on the current phase in doc 06. One phase per session, one
  branch per phase: `phase/<n>-<name>`. One commit per logical change with a
  message stating what and why.
- Do not start a phase until the previous phase's "Done when" lines are
  verified.
- Tick the checkbox in doc 06 only after you have run the check, not after
  writing the code.
- At the end of each phase, write a short summary of what changed, what you
  tested, and anything you were unsure about, for the reviewer.

## Commands
Verify real scripts in each package.json before running; do not assume.
Expected: install, dev, build, lint, typecheck, test in `web/` and `checker/`.

## Security non-negotiables
1. Never fetch a user-supplied URL outside the SSRF guard module. No direct
   `fetch(userUrl)` anywhere else.
2. Every database access goes through the data-access layer with a `userId`.
   No queries in route handlers.
3. Internal endpoints verify the HMAC signature and timestamp on every call.
4. Secrets only in environment variables. Never commit, log or echo them.
   Keep `.env.example` names-only.
5. Alert channel configs are encrypted at rest and never returned to the
   client after creation.
6. Never store response bodies or headers from monitored sites.
7. Security modules (guard, HMAC, data-access, state machine) require unit
   tests before the code that depends on them.

## Dependencies and tools
- Before installing any package, check its current documentation and latest
  stable version, pin the version, and justify the addition in the commit
  message. Prefer fewer dependencies.
- Do not install or invoke agent skills, plugins or MCP servers that are not
  already in this project's `.agents` folder. In particular, do not use the
  10k-websites / cinematic scroll-video skill here: this is an application,
  not a marketing site.

## Identity and privacy
Set git author name and email to the project's alias identity before the
first commit. No real name, personal email, phone number or location in
code, comments, docs, metadata, or commit history.

## Off-limits without explicit approval
Billing or payments, teams, SMS, multi-region checks, an anonymous
"check any site" box, API keys, third-party analytics or trackers, storing
bodies, any change to the quotas or thresholds in docs 02 and 05, any
product copy that makes promises about response times, pricing or uptime.

## Definition of done (every task)
1. Build, lint, typecheck and tests pass.
2. The phase's "Done when" lines are verified and recorded.
3. No new console errors; no secrets in the diff.
4. Responsive check at 360 px for any UI change.
5. A second model has reviewed the diff against the docs and its findings
   are resolved or explicitly answered.
