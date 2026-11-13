# Phase 8 verification

Owners can create, edit, publish, unpublish and delete status pages. Each
page can list up to ten of the owner's monitors, and URLs are hidden by
default. An opted-in URL shows its origin and path. Published pages show
overall and per-monitor status, 30 days of availability, and the newest
ten incidents overlapping the last 30 days, including ongoing incidents.
When every monitor is paused or blocked, the page reports Unknown with a
note that there are no active monitors.

The owner approved the reserved slug list and the requirement to publish
again after a page loses its last monitor. An additive database migration
reserves renamed and deleted slugs for 30 days and makes empty pages draft.

## Completion checks

| Check | Evidence |
| --- | --- |
| Publish | A draft returned 404. The next public request after publishing showed the page and populated its tagged history cache. |
| Unpublish and rename | After priming history, the next request to the unpublished or old slug returned 404. The renamed path served the page. |
| Hide URL and remove monitor | The next request omitted the previously public URL, removed monitor, and that monitor's incident history. |
| Edit, pause and delete monitor | The next requests showed the edited name, then Unknown for an all-paused page, then 404 after the final monitor was deleted. Adding a replacement kept the page in draft until explicit publication. |
| Delete account | An isolated test route exercised the same owner-bound account deletion service used by the authenticated data layer. The next request to the primed public path returned 404, the slug was reserved, and the previous session was redirected to sign in. |
| Generic 404 and privacy | Draft and unknown slugs returned identical no-store HTML and the same readable 404 without JavaScript. Public HTML omitted hidden addresses, URL queries and fragments, owner details, private IDs and unrelated monitor data. |

Chromium ran against a production build backed by an isolated PostgreSQL 18
instance with a restricted application role. It checked the owner editor
at 360 px and the JavaScript-disabled public page and expandable daily
history at 360 and 1440 px. It also checked that foreign page and monitor
IDs and cross-origin writes were rejected. Successful browser flows
produced zero console errors and zero external requests. The fixture
database and synthetic credentials were removed after testing.

Native PostgreSQL concurrency checks also verified the three-page cap,
competing slug claims, and concurrent deletion of a page's last monitors.
The framework cache probe confirmed that a warmed history entry was
reused, and that immediate tag expiration refreshed it on the next request.

## Implementation notes

Public publication, membership, status and URL visibility are read live.
Only availability and incident history are cached, with a 60-second
maximum age. The pinned framework's dynamic 404 initially rendered a
blank screen without JavaScript. The public status route now uses a
scoped proxy check to serve a readable 404. The page checks visibility
again before rendering. A request already in progress during revocation
can reach the framework fallback between those reads.

An independent model reviewed the diff against the requirements. Its
account-deletion finding was resolved by expiring the affected tags
after the account transaction commits. The account-deletion settings
flow is scheduled for Phase 10. Verification ran locally against the
production build. Applying the migration to the hosted database and
deploying the app are rollout steps.

## Regression checks

Build, lint, type checking, 358 web tests, 360 checker tests, six native
Worker runtime tests, the configured credential scan, and the Git
whitespace check passed. No package changes were required.
