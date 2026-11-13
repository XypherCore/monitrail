# 04 — UI/UX Design Brief: Monitrail (rev 2)

## Aesthetic
Calm, dense, trustworthy operations tool. Dark-first, minimal, data forward.
Closer to a status dashboard than a marketing site. Restrained motion.
Avoid: neon cyberpunk, fake terminal looks, gradient-heavy hero art, 3D.

## Tokens
```css
:root{
  --bg:#0B0E13;
  --panel:#121722;
  --panel-2:#171D2B;
  --border:#222B3B;          /* decorative dividers only, NOT for controls */
  --border-strong:#64748B;   /* input, button and control boundaries */
  --text:#E6EAF2;
  --muted:#8A94A7;
  --accent:#38BDF8;
  --up:#34D399;
  --down:#F87171;
  --pending:#FBBF24;
  --paused:#64748B;
}
```
Computed contrast (WCAG): `--border-strong` is 3.77:1 on `--panel` and 4.06:1
on `--bg`, so it meets the 3:1 requirement for control boundaries. `--muted`
is 5.87:1 on `--panel` and 6.33:1 on `--bg`. `--border` is about 1.36:1 on
`--bg` and is only for decorative separators between content, never for a
control's edge. Re-compute any new colour before using it.
- 4.5:1 for body text, 3:1 for large text and control boundaries.
- Accent only on the primary CTA, focus rings and links.

## Status presentation
Never colour alone: every state has an icon and a text label.
| State | Colour | Label |
|---|---|---|
| Up | `--up` | Up |
| Down | `--down` | Down |
| Pending | `--pending` | Pending |
| Confirming | `--pending` + pulse | Confirming |
| Paused | `--paused` | Paused |
| Blocked | `--paused` + shield icon | Blocked |
| Unknown | neutral outline + "?" | Unknown |

## Typography
Geist Sans for UI, Geist Mono for URLs, numbers, timestamps (tabular
figures). System fallback. Base 14 px for dense tables; headings 20 / 24 / 32.

## Components
- Radius 10 px on cards, 8 px on inputs and buttons.
- Borders over shadows; one subtle shadow on popovers at most.
- Inputs and buttons use `--border-strong`.
- Monitor row: state, name, URL (mono, truncated, query string masked),
  availability 24 h, avg response, last checked (relative).
- Forms: visible labels, inline validation, helper text for URL rules.
- Destructive actions use `--down` only inside confirm dialogs.

## Charts and the daily bar (must match doc 05 definitions)
- Response chart: line of the **average of successful checks** per bucket,
  with a lighter **p95** line. Buckets: 24 h = 15 min, 7 d = 1 h,
  30 d = 6 h. A bucket with no successful checks is a gap labelled
  "No data"; never draw zero. Tooltip shows value and sample count.
- Failed checks do not appear in latency; they appear as incident bands
  across the chart's x-axis.
- Daily availability bar: 30 segments, one per UTC day, using the same
  availability formula for that day. 100% = `--up`; from 99% up to below
  100% = `--pending` with label "Partial"; below 99% = `--down`; no data =
  `--paused` outline. Tooltip: date, availability, coverage, incidents.
- Availability numbers show "Not enough data" when coverage is too low
  (doc 05), never a misleading 100%.

## Motion
120 to 180 ms ease-out on hover and state changes only. A slow pulse on the
Confirming and Pending dots. Honour `prefers-reduced-motion` completely.

## Responsive
Mobile-first. Sidebar becomes a bottom tab bar under 768 px. The monitor
table becomes stacked cards. Charts readable at 360 px. Tap targets at least
44 px on touch.

## Accessibility
Landmarks, skip link, real heading hierarchy, visible `:focus-visible` in
the accent, labels on every input, a live region announcing state changes on
the detail page, keyboard-operable everything.

## Public status page
Light on chrome: title, overall banner, per-monitor rows with the 30-day
bar, recent incidents, "Powered by Monitrail" footer link. Core content
works with JavaScript disabled.
- Overall status precedence: Down > Unknown > Confirming > Pending > Up.
  Paused and Blocked monitors are listed greyed and excluded from the
  overall status. If every listed monitor is Paused or Blocked, show
  Unknown and explain that there are no active monitors.
- Public incident fields: started, resolved, duration, and a human cause
  label (for example "Connection timed out"). No URL, no raw error text.
  Show the newest 10 incidents that overlap the past 30 days, including
  ongoing incidents.
- An empty or unpublished page is a generic 404.
