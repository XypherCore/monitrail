# 04 — UI/UX Design Brief: Monitrail

## Aesthetic
Calm, dense, trustworthy operations tool. Dark-first, minimal, data forward.
Closer to a status dashboard than a marketing site. Restrained motion only.
Avoid: neon cyberpunk, fake terminal looks, gradient-heavy hero art, 3D.

## Tokens
```css
:root{
  --bg:#0B0E13;            /* canvas, tinted not pure black */
  --panel:#121722;         /* cards, tables */
  --panel-2:#171D2B;       /* hover, raised */
  --border:#222B3B;
  --text:#E6EAF2;
  --muted:#8A94A7;         /* check contrast: 4.5:1 on --bg for body text */
  --accent:#38BDF8;        /* CTA, focus rings, links, nothing else */
  --up:#34D399;
  --down:#F87171;
  --pending:#FBBF24;
  --paused:#64748B;
}
```
Rules:
- Compute contrast: 4.5:1 for body text, 3:1 for large text and UI borders.
- The accent appears only on the primary CTA, focus rings and links.
- Status never relies on colour alone: always pair with an icon and a text
  label (Up, Down, Pending, Paused).

## Typography
Geist Sans for UI, Geist Mono for URLs, numbers and timestamps (tabular
figures so values do not jitter). Fall back to the system stack. Sizes:
12 / 14 / 16 base 14 for dense tables, headings 20 / 24 / 32.

## Components
- Radius 10 px on cards, 8 px on inputs and buttons.
- Borders over shadows. At most one subtle shadow on popovers.
- Monitor row: status dot + name, URL (mono, truncated), uptime 24 h,
  avg response, last checked (relative time).
- Uptime bar: 30 narrow segments, one per day, colour by that day's status,
  tooltip with the exact figure.
- Response chart: single line, p95 as a lighter secondary line, hover reads
  out exact values. No chart junk, no animation on load.
- Buttons: one primary per screen, secondary as outline, destructive in
  `--down` only inside confirm dialogs.
- Forms: visible labels, inline validation, helper text for URL rules.

## Motion
Transitions 120 to 180 ms, ease-out, on hover and state changes only. A slow
pulse on the Pending dot. Honour `prefers-reduced-motion` completely.

## Responsive
Mobile-first. Sidebar becomes a bottom tab bar under 768 px. Monitor table
becomes stacked cards. Charts stay readable at 360 px width. Tap targets at
least 44 px on touch devices.

## Accessibility
Landmarks (`nav`, `main`, `footer`), a skip link, real heading hierarchy,
visible `:focus-visible` rings in the accent, labels on every input, live
region announcing status changes on the detail page.

## References for feel (not to copy)
Better Stack and Linear for density and calm; GitHub's status page for the
public page layout.

## Public status page
Light on chrome: title, overall status banner, per-monitor rows with the
30-day uptime bar, recent incidents list, "Powered by Monitrail" footer link.
Must work with JavaScript disabled for the core content.
