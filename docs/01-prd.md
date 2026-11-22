# 01 — PRD: Monitrail (rev 2)

## App name and tagline
**Monitrail** — Know when your site goes down before your users do.

## Problem
Site owners and freelancers usually learn about downtime from an angry
customer. Existing tools are heavy dashboards priced per monitor, or
self-hosted projects that need a server. Freelancers who maintain client
sites also lack a simple way to show "your site was available 99.97% this
month."

## Target user
A freelance developer or small business owner who runs 1 to 10 websites and
wants to be told, quickly and reliably, when one stops responding. Not an
enterprise team.

## Value proposition
- Setup in under two minutes: sign in, paste a URL.
- Security-first: the checker and every outbound call are hardened against
  SSRF and abuse by design.
- Shareable proof: public status pages usable in client reports.

## Core features (must have, v1)
1. **Sign-in**: OAuth (GitHub, Google). No passwords. Signups are
   invite-only until the dogfood period ends (`SIGNUP_MODE=invite`).
2. **Monitors**: create, edit, pause, resume, delete. Fields: name, URL
   (http/https), interval (5, 10, 15, 30 or 60 min; default 5), expected
   status (`2xx` default, or `2xx or 3xx`). Method is always GET and timeout
   is always 10 s; neither is user-configurable in v1. The hosted service
   admits up to 40 monitors in total.
3. **Checks** record: HTTP status code, response time (request start to
   response headers), and a classified error (`dns`, `timeout`, `tls`,
   `connect`, `bad_status`, `blocked`, `other`).
4. **Incidents**: a failing monitor is re-checked every 60 s until confirmed.
   2 consecutive failures confirm an incident; 2 consecutive successes
   confirm recovery. The same 60 s rule applies while confirming recovery.
5. **Monitor states shown to users**: Pending, Confirming (first failure
   seen, not yet confirmed), Up, Down, Paused, Blocked, Unknown (no recent
   checks). Unknown is never displayed as Up.
6. **Dashboard**: state, availability % (24 h, 7 d, 30 d), average and p95
   response time (successful checks only), response-time chart.
   Availability is time-based and derived from incidents (definition in doc
   05). It shows "Not enough data" instead of a number when coverage is too
   low.
7. **Incident log** per monitor: observed start, confirmed time, resolved
   time, duration, cause, and why it closed (recovered, paused, config
   changed, blocked).
8. **Alerts** on confirmed down and confirmed recovery through Telegram,
   Discord, Slack and a generic webhook (versioned JSON payload with an
   `event_id`). A crash or a lost delivery acknowledgment can cause a
   duplicate. Receivers can deduplicate on `event_id`. Telegram is linked
   by a one-time code from the destination chat (private chats only in v1).
9. **Public status pages**: each user can create up to 3 pages, each with up
   to 10 of their monitors. A page needs at least one monitor to publish.
   It shows overall status, per-monitor state, a 30-day availability bar and
   recent incidents. The monitored URL is hidden unless the owner enables it
   per monitor.
10. **`/bot` page**: how the checker identifies itself, an abuse contact
    (alias address), and how site owners request a block.

## Nice to have (v1.1+)
SSL expiry alerts, email alerts (needs a verified domain), monthly report
(HTML/PDF) for client retainers, custom status-page domain, keyword check,
"check now" button, Telegram group chats.

## Out of scope for v1
Billing or payments, teams or organisations, SMS or phone alerts,
multi-region checks, an anonymous "check any site" box, API keys, mobile
app, storing response bodies, third-party analytics or trackers,
user-configurable method or timeout.

## User stories
- As a freelancer, I add a client's URL so I'm alerted before the client
  notices.
- As a site owner, I get a Telegram message when my site is confirmed down
  and when it recovers.
- As a freelancer, I share a public status page as proof of availability.
- As a site owner, I read response-time trends to spot slowdowns early.
- As the owner of a monitored site, I read how the checker identifies itself
  and can request a block.

## Success metrics (each with a definition)
- **Time to first monitor**: a new user creates a working monitor in under
  2 minutes (measured by hand with 3 test users).
- **Dogfood**: Monitrail monitors the Aelvon portfolio and itself for 14
  consecutive days with zero false incidents (every incident
  reviewed by hand).
- **Missed checks** under 1%: a missed check is an active 5-minute slot with
  no recorded result within the interval plus 60 s. Active time excludes
  paused periods. Denominator = expected slots over the period.
- **Security**: the SSRF suite, IDOR suite, cache-revocation suite and
  deletion test all pass in CI.

## Schedule
Build milestone: 4 weeks (phases 0 to 10 in doc 06). Proof milestone: 14
consecutive clean days after deploy (phase 11). Total about 6 weeks. If the
build slips, scope changes need the owner's approval; the agent may not cut
or add scope by itself. A failed dogfood day (false incident, missed-check
breach) restarts the 14-day count after the fix.

## Source release

The repository is private during development and will be released as open
source when the app is deployed in Phase 11. The hosted service remains
invite-only through dogfood. The owner selects the open-source license
before making the repository public.

## Identity and remaining owner decisions
1. Brand owner: XypherCore (parent organisation). Maintainer identity stays
   an alias for now (see doc 02) and may later change to the owner's real
   name. All identity strings (brand name, maintainer name, abuse contact,
   footer text) live in ONE config file so that change is a one-file edit.
   Never hard-code identity strings elsewhere.
2. Hosting plan and commercial status must be reconsidered before opening
   public signups (see doc 02, "Hosting terms"). The Phase 11 choices below
   apply to the personal, invite-only dogfood period.

## Phase 11 owner decisions

The owner approved Vercel Hobby for personal, non-commercial,
unmonetized, invite-only dogfood, Cloudflare Free, a fresh Supabase Free
project, the existing MIT license and `monitrail.duckdns.org`. Source is
released when deployment passes its checks. Public signups remain closed.

The dogfood targets are `https://aelvon.vercel.app` and Monitrail's canonical
origin. The owner excluded the previously proposed client site from scope.
Three anonymous human first-monitor trials remain required. Their timer
ends when the first healthy result appears.

Proof uses fixed five-minute slots anchored to each monitor's proof start,
server acceptance timestamps, one result per slot and 60 seconds' grace.
Less than 1% of slots may be missed per monitor and across the fleet in
each 24-hour proof day. Slots intersecting paused time are excluded.
Configuration changes restart the proof run. A failed day restarts the
14-day count after the fix. This does not alter the scheduler's timing.
