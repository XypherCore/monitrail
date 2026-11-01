# 03 — App Flow: Monitrail

## Pages
| Route | Auth | Purpose |
|---|---|---|
| `/` | public | Short landing page: what it does, one sign-in CTA |
| `/login` | public | OAuth buttons (GitHub, Google) |
| `/dashboard` | user | All monitors with status, uptime %, avg response |
| `/monitors/new` | user | Create a monitor |
| `/monitors/[id]` | user | Chart, incident log, edit, pause, delete |
| `/channels` | user | Add and test Telegram and webhook channels |
| `/status-pages` | user | Create status page, pick monitors, set slug, publish |
| `/settings` | user | Account info, delete account and all data |
| `/status/[slug]` | public | Public status page (cached) |
| `/bot` | public | Checker identity, abuse contact, block request |
| `/404`, `/error` | public | Friendly error pages |

## Navigation
Desktop: left sidebar (Dashboard, Channels, Status pages, Settings).
Mobile: bottom tab bar with the same four items.
Public pages: minimal top bar with the Monitrail wordmark only.

## First screen
A new visitor sees the landing page: one headline, one line of explanation,
a sample status card, and "Sign in" (primary). No pricing, no tour.

## Auth flow
Landing -> Sign in -> OAuth provider -> callback -> `/dashboard`.
First login lands on the empty dashboard. Logout returns to `/`.
Unauthenticated access to a user route redirects to `/login?next=<path>`;
after login the user returns to `next`.

## Key journeys
**1. Add a monitor**
Dashboard (empty state) -> "Add monitor" -> enter name and URL -> the server
validates the URL (SSRF guard, blocklist, quotas) -> monitor created in
`pending` state -> user lands on its detail page -> first result appears
within about a minute and status becomes `up` or `down`.

**2. Site goes down**
Checks fail -> fast retries every 60 s -> after 2 failures an incident opens
-> Telegram/webhook alert fires once -> dashboard shows `down` with the
incident -> checks continue at the normal interval -> after 2 successes the
incident resolves and a recovery alert fires.

**3. Publish a status page**
Status pages -> "New page" -> choose title and slug -> select monitors ->
toggle "show URL" per monitor (off by default) -> publish -> copy the public
link.

**4. Connect an alert channel**
Channels -> "Add Telegram" shows steps (start the bot, paste chat ID) or
"Add webhook" (paste URL) -> "Send test alert" -> channel marked verified
only after the test succeeds.

## Empty, loading and error states
- Dashboard with no monitors: explanation plus an "Add monitor" button.
- Monitor in `pending`: "Waiting for first check" with a subtle pulse.
- Monitor `paused`: greyed out, no checks, clear "Resume" action.
- Monitor detail with fewer than 2 data points: chart replaced by a message.
- URL rejected by the guard: plain-language reason ("This address points to
  a private network and can't be monitored"). Never leak internal details.
- Quota reached: show current usage and what is limited.
- Channel test fails: show the provider's error category, not secrets.
- Public status page for an unpublished or unknown slug: generic 404.
- Network or server error: retry action, no stack traces.
- Loading: skeleton blocks matching the final layout, no bare "Loading".

## Modals and overlays
Delete monitor, delete channel, delete account: confirm dialog stating
exactly what will be removed. Nothing else uses modals.

## Redirects
After creating a monitor -> its detail page. After deleting a monitor ->
`/dashboard`. After logout -> `/`. Deleted account -> `/` with a short
confirmation message.
