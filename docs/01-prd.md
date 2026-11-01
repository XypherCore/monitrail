# 01 — PRD: Monitrail

## App name and tagline
**Monitrail** — Know when your site goes down before your users do.

## Problem
Site owners and freelancers usually learn about downtime from an angry
customer. Existing tools are either heavy dashboards priced per monitor or
self-hosted projects that need a server. Freelancers who maintain client
sites also have no simple way to show a client "your site was up 99.97% this
month."

## Target user
A freelance developer or small business owner who runs 1 to 10 websites and
wants to be told, quickly and reliably, when one stops responding. Not an
enterprise team. Comfortable pasting a Telegram chat ID or a webhook URL.

## Value proposition
- Fast setup: sign in, paste a URL, done in under two minutes.
- Security-first: the checker is hardened against SSRF and abuse by design.
- Shareable proof: a public status page per site, usable in client reports.

## Core features (must have, v1)
1. Sign in with OAuth (GitHub and Google). No passwords stored.
2. Monitors: create, edit, pause, delete. Fields: name, URL (http/https
   only), interval (5 min default and minimum), expected status (default
   any 2xx).
3. Scheduled checks measuring: HTTP status, response time (ms), and a
   classified error (dns, timeout, tls, connect, bad_status, blocked).
4. Incident logic: open an incident after 2 consecutive failures, resolve
   after 2 consecutive successes. Failing monitors are re-checked every 60 s
   until the state settles.
5. Dashboard: current status, uptime % (24 h, 7 d, 30 d), average response
   time, response-time chart.
6. Incident log per monitor: start, end, duration, cause.
7. Alerts on down and recovery via Telegram and generic webhooks
   (Discord/Slack-compatible). Each alert is sent once per incident per
   channel.
8. Public status page per user: chosen monitors, current status, 30-day
   uptime bar, recent incidents. No login required.
9. A public /bot page explaining the checker's User-Agent, with an abuse
   contact and a block-my-site request path.

## Nice to have (v1.1+)
- SSL certificate expiry check and alert
- Email alerts (needs a verified sending domain)
- Monthly uptime report (HTML/PDF) for client retainers
- Custom domain for the status page
- Keyword/content check
- "Check now" button

## Out of scope for v1
Billing or payments, teams/organisations, SMS or phone alerts, multi-region
checks, anonymous "check any site" public box, API keys, mobile app, storing
response bodies, third-party analytics or trackers.

## User stories
- As a freelancer, I want to add a client's URL so that I'm alerted before
  the client notices.
- As a site owner, I want a Telegram message when my site is down and when
  it recovers so that I can react immediately.
- As a freelancer, I want a public status page so that I can send a client
  proof of uptime.
- As a site owner, I want to see response-time trends so that I can spot
  slowdowns early.
- As the owner of a monitored site, I want to read how the checker
  identifies itself and ask to be blocked.

## Success metrics
- A new user creates a working monitor in under 2 minutes.
- Dogfood: Monitrail monitors Jumeirah Fashion, the Aelvon portfolio and
  itself for 14 days with zero false incidents (reviewed by hand).
- The SSRF test suite and the cross-user access (IDOR) tests pass in CI.
- Checker misses fewer than 1% of scheduled checks over the dogfood period.

## Open decisions (agent must not invent answers; ask the owner)
1. Brand owner: Aelvon, XypherCore, or standalone. Default until decided:
   no personal identifying information anywhere in the repo, UI or commits.
2. Repo visibility. Default: private until v1 ships.
3. Domain. Default: free *.vercel.app subdomain.
