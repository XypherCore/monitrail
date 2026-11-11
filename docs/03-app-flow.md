# 03 — App Flow: Monitrail (rev 2)

## Pages
| Route | Auth | Purpose |
|---|---|---|
| `/` | public | Short landing page, one sign-in CTA |
| `/login` | public | OAuth buttons (GitHub, Google); invite code step while `SIGNUP_MODE=invite` |
| `/dashboard` | user | All monitors with state, availability, avg response |
| `/monitors/new` | user | Create a monitor |
| `/monitors/[id]` | user | Chart, incident log, edit, pause or resume, delete |
| `/channels` | user | Add, verify and test alert channels |
| `/status-pages` | user | Create pages, pick monitors, publish |
| `/settings` | user | Account info, delete account and all data |
| `/status/[slug]` | public | Public status page (cached, see doc 02) |
| `/bot` | public | Checker identity, abuse contact, block request |
| `/api/health` | public | 200 or 503 only, no body details |
| 404 / error | public | Friendly pages, no stack traces |

## Navigation
Desktop: left sidebar (Dashboard, Channels, Status pages, Settings).
Mobile: bottom tab bar with the same four items. Public pages: minimal top
bar with the wordmark only.

## First screen
New visitor: one headline, one line of explanation, a sample status card,
"Sign in". No pricing, no tour.

## Auth flow
Landing -> Sign in -> OAuth provider -> callback -> `/dashboard`.
In invite mode a first-time user enters an invite code before the account
is created. Logout returns to `/`. Unauthenticated access to a user route
redirects to `/login?next=<path>`; `next` is accepted only if it is a
same-origin path (single leading `/`, no `//`, no backslash, no scheme);
anything else becomes `/dashboard`.

## Monitor states and what the user sees
| State | When | Shown as |
|---|---|---|
| Pending | Created or resumed, no result yet | "Waiting for first check" (first check due within about a minute) |
| Confirming | Pending or Up with 1 failure, or Down with 1 success | "Confirming" with a note that a recheck runs in about 60 s |
| Up | Confirmed healthy | Up |
| Down | Confirmed incident open | Down + incident start time |
| Paused | `is_paused` by the user | Paused |
| Blocked | Paused because the host is on the blocklist | Blocked + plain explanation |
| Unknown | No accepted result for 3 x interval | Unknown, with "No recent checks" and a link to the affected monitor's check history |
Unknown is never styled or counted as Up.
The dashboard and monitor detail refresh once per minute while the tab is
visible.

## Key journeys
**1. Add a monitor**
Dashboard empty state -> Add monitor -> enter name, URL, interval, expected
status -> server validates (static rules, DNS to public addresses, blocklist,
quotas, rate limit) -> monitor created as Pending with `next_check_at = now`
-> detail page -> first result within about a minute: Up, or Confirming if
the first check failed.

**2. Site goes down**
Check fails -> state Confirming, recheck every 60 s -> second failure
confirms: incident opens, Down, outbox rows created, alerts sent once per
channel (at-least-once) -> checks continue at the interval, with 60 s
rechecks while recovery is unconfirmed -> second success resolves the
incident, Up, recovery alerts go to channels that got the down alert.

**3. Publish a status page**
Status pages -> New page -> title and slug (3 to 40 chars, lowercase,
reserved words blocked, slugs deleted within 30 days cannot be reused) ->
pick 1 to 10 monitors, toggle show-URL per monitor (off by default) ->
publish (needs at least one monitor) -> copy link. Any later change
invalidates the cached page immediately (doc 02).

**4. Connect Telegram**
Channels -> Connect Telegram -> app shows a `t.me` deep link with a one-time
code (10 min) -> user opens it and presses Start in the bot's private chat
-> the channel becomes verified and the app shows it as connected. Test
alerts are rate limited.

**5. Connect Discord, Slack or webhook**
Paste the URL (Discord and Slack must be official webhook URLs; generic
webhooks must be HTTPS) -> "Send test alert" through the guarded transport
-> verified only after the test succeeds.

**6. Pause, resume, edit**
Pause: monitor stops, any open incident closes as "paused" with no recovery
alert. Resume: Pending. Edit URL or expected status: Pending and any open
incident closes as "config changed". Show this on the incident log.

## Empty, loading and error states
- Dashboard with no monitors: explanation plus Add monitor.
- Detail page with fewer than 2 data points: message instead of a chart.
- Chart buckets with no data render as gaps with "No data".
- Availability coverage too low: "Not enough data" in place of a number.
- URL rejected: plain-language reason ("This address points to a private
  network and can't be monitored"). Never leak internal details.
- Quota or rate limit reached: show the limit and when it resets.
- Channel test failure: show the error category only.
- Unpublished or unknown slug: the same generic 404.
- Offline or server error: retry action, no stack traces.
- Loading: skeletons that match the final layout.

## Modals
Confirm dialogs only for deleting a monitor, channel, status page or the
account, stating exactly what will be removed. Account deletion removes all
data and revokes sessions at once.

## Redirects
After creating a monitor -> its detail page. After deleting a monitor ->
`/dashboard`. After logout -> `/`. After account deletion -> `/` with a
short confirmation.
