# Phase 11 deployment and proof runbook

Phase 11 deploys the reviewed application, releases its source and gathers
14 consecutive days of real operating evidence. Deployment alone does not
complete the phase. The owner approved the launch choices and proof rules
in docs 01 and 07 on 2026-11-22.

## Production configuration

Use Vercel Hobby for the personal, non-commercial, unmonetized invite-only
dogfood, Cloudflare Free and a fresh Supabase Free project with its Data
API disabled. The canonical origin is `https://monitrail.duckdns.org`.
The source license is MIT. Reconsider hosting terms before public signups.

The Vercel project uses `web` as its root, Node 24 and the pinned root
lockfile. Keep shared source outside that root included. `web/vercel.json`
uses the workspace build and a repository-root lockfile installation,
including the pinned development build tools, without package
lifecycle scripts. Keep deployment logs and source private using the CLI's
default settings. Root
`.vercelignore` excludes local credentials, operator state and build output.
Fluid compute is enabled so post-response alert work has the platform's
supported lifecycle. The existing monitor and delivery timeouts are
unchanged. [Vercel duration limits](https://vercel.com/docs/functions/configuring-functions/duration).

Keep the production connection strings in ignored
`web/.env.production.local`. DATABASE_URL initially uses the transaction
pooler. MIGRATION_DATABASE_URL uses the session pooler or direct endpoint.
Run the fresh-project command once from the repository root:

```sh
npm run db:prepare-production --workspace web
```

This applies the committed migrations and creates the restricted
`monitrail_app` role without fixtures. It replaces only the production
runtime connection with that role. It refuses existing application data,
foreign tables and altered migration history. A confirmed, already
migrated empty target requires the explicit `--resume-after-migration`
option when invoking the underlying script from `web`. Do not use the
development fixture verification command on production.

Preserve a `.pending` recovery file if a role commit succeeds but its local
file rename fails. The helper never rotates an existing role's credential.
Keep the project isolated from other writers during bootstrap.

Configure the owned public abuse alias and OAuth applications. GitHub's
callback is `/api/auth/callback/github`; Google's is
`/api/auth/callback/google` on the canonical origin. The configuration
command can explicitly reuse only the four OAuth application credentials
from development. It generates separate production session, signing and
encryption keys. Existing production keys are preserved on retry.

```sh
npm run deploy:configure-production --workspace web -- \
  --origin https://monitrail.duckdns.org \
  --abuse-contact '<owned-public-alias>' \
  --reuse-oauth-apps --upload
```

Use `--prepare-only` instead of `--upload` to prepare locally. Provide
separate production OAuth settings in the production file and omit
`--reuse-oauth-apps` when using separate provider applications. Never pass
secrets as command arguments. Production Telegram linking requires
TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME; the command generates a fresh
webhook secret when these are supplied together. Register the bot's
authenticated HTTPS webhook after deployment.

For the approved production origin, set the existing GitHub OAuth app's
Homepage URL to `https://monitrail.duckdns.org` and Authorization callback
URL to `https://monitrail.duckdns.org/api/auth/callback/github`. In the
existing Google Web application client, set the Authorized JavaScript
origin to `https://monitrail.duckdns.org` and Authorized redirect URI to
`https://monitrail.duckdns.org/api/auth/callback/google`. Preserve the
existing client credentials when only changing these addresses. Replacement
OAuth apps require their corresponding credentials to be uploaded and
deployed before testing. Provider dashboard changes still need live sign-in
acceptance; a loaded login page does not verify a callback.

The command uploads only allowlisted runtime settings, as production-only
Vercel secret variables. It excludes the migration credential and local CA
paths. It refuses stale production variables absent from the desired
configuration and incomplete paginated metadata. Remove stale settings
deliberately before retrying. A provider CA file can be validated and sent
as DATABASE_CA_PEM to the host. The local production file retains its file
setting. TLS verification is always enabled.

The checker's APP_URL is committed in `checker/wrangler.jsonc`. Create
`monitrail-check-ticks`, supply the same INTERNAL_HMAC_SECRET to the Worker,
and deploy its private Queue consumer and both schedules. It has no
database credential, public Worker endpoint or preview URL. Verify minute
ticks and measure the daily maintenance invocation's CPU on the Free plan.

From the repository root, connect the deployed services with the private
production configuration:

```sh
npm run deploy:connect-services --workspace web -- \
  --upload-checker-key --register-telegram
```

The owner runs this local command when the agent's credential-protection
guard blocks private-file execution. It uploads the signing key through
standard input and registers Telegram through the guarded transport.
Neither action prints credentials. Secret-name metadata is read separately
from the suppressed upload output. Requested local settings and TLS
configuration are validated before any upload. The checker key is uploaded
before the Telegram database connection opens. A failed operation reports
only its fixed stage and the operations already confirmed complete; it
does not roll back an uploaded key. Retry only the remaining operation
when a previous one is confirmed complete. A successful web deployment
does not substitute for this connection or a healthy checker heartbeat.
Telegram registration failures may also include a fixed guard category.
This never includes provider descriptions, response bodies or tokens.
An unsuccessful provider response does not by itself establish that the
bot token is wrong. Registration success must still be followed by linking
the owner's private chat and receiving a real test alert.

For a local-settings failure, run the isolated diagnostic mode:

```sh
npm run deploy:connect-services --workspace web -- --check-settings
```

It prints only fixed setting names and PASS/FAIL, reads the canonical
owner-only production file without changing its permissions, and makes no
database, provider or Worker calls. It cannot be combined with connection
flags. A failed production-file check makes the later results unavailable.
Use the failed field names to correct local settings; never paste values
or raw provider errors into a public issue.

Create a single-use production invitation separately:

```sh
npm run auth:invite-production --workspace web
```

The command reads the canonical ignored production file and refuses
conflicting ambient database or CA settings. It uses the restricted
runtime role, stores only the invitation hash and saves the code in
ignored `web/.env.invite.production.local` with owner-only permissions.
Open that file locally and keep the file private. Share a code only with
its intended invitee through a private channel; never publish it. After
consuming the code, remove the file before generating another invitation.
The development invitation command remains separate.

Set the GitHub repository variable APP_URL and run the health workflow
manually. The owner must enable failure notifications. Register production
provider callbacks, verify both sign-ins and test real alert delivery.
Verify the hosted runtime's TLS connection, response headers, ownership
checks and public-cache revocation. Only after deployment checks and
source/history scans pass, make the MIT repository public.

## Verified host-block requests

Verify domain control by the documented domain reply or token file before
using the administrator command. From `web`, with the administrative
environment loaded locally:

```sh
node scripts/admin/block-host.ts add example.com --dry-run
node scripts/admin/block-host.ts add example.com --apply --confirm-domain-control
node scripts/admin/block-host.ts remove example.com --apply --confirm-domain-control
```

Subdomains are included by default. Use `--exact-host` only for an exact
host block. The command does not contact the supplied host. Claim and
maintenance apply the blocked lifecycle. Removing an entry does not resume
monitors automatically.

## Private evidence collection

Create only the two approved dogfood monitors: the Aelvon portfolio and
Monitrail itself, at five-minute intervals. Record their IDs, revisions and
a common UTC proof start after deployment acceptance. Keep their
configuration unchanged. The owner excluded the previously proposed
client site. No checks against that site form part of this proof.

### Automatic encrypted capture

The owner approved automatic collection. The proof workflow runs at
02:43 and 14:43 UTC when the repository variable DOGFOOD_ENABLED is
`true` and APP_URL is configured. A manual dispatch requires complete
configuration and fails if it is missing. GitHub schedules can be delayed.

Prepare the dedicated keys with the configuration command's
`--enable-proof-capture` option. Make the verified GitHub CLI available on
PATH for this command. The dedicated export key goes to Vercel and GitHub;
the proof encryption key goes only to the private local file and GitHub.
Existing production keys are preserved. The exporter refuses the checker
key for proof authentication. Database credentials are never uploaded to
GitHub.

After the two approved monitors exist, add their comma-separated IDs as
DOGFOOD_EXPORT_MONITOR_IDS in the ignored production file. Re-run the
production configuration command and deploy the updated environment.
The signed export accepts no IDs or time bounds from a request. It uses
the two server-configured IDs and a rolling 24-hour database-clock window.
Without both configured IDs it fails closed.

Before enabling the schedule, manually dispatch the proof workflow and
verify that its encrypted artifact can be downloaded and decrypted. The
artifact name includes the run ID and attempt. Only `dogfood-evidence.enc`
is uploaded, with 30-day retention. Encryption occurs before the first
file write. The format is `v1.<key-id>.<nonce>.<ciphertext-and-tag>` using
AES-256-GCM and authenticated version/key-ID metadata. The default key ID
is `proof-1`; preserve it or configure the same ID for capture/decryption.

Download artifacts into the private durable evidence directory. With the
proof key loaded locally, decrypt each new snapshot:

```sh
node --env-file=web/.env.production.local scripts/decrypt-dogfood.mjs \
  --input /private/monitrail-proof/dogfood-evidence.enc \
  --output /private/monitrail-proof/new-snapshot.json
```

Use the first verified database snapshot to record the common proof start
and baseline revisions in the private manifest, then enable the scheduled
workflow. Keep every encrypted capture and decryption key backed up.
Capture failures require attention before one-day receipt retention
creates an evidence gap. An incomplete proof never counts as a pass.
After the final 14-day grace cutoff, trigger a final manual capture and
verify its query window extends beyond that cutoff before final scoring.

### Manual fallback and assessment

Keep evidence in a private durable directory outside the checkout, with
owner-only directory permissions. Do not use temporary storage as the sole
14-day record. The exporter and scorer refuse source-tree output, symlinks
and overwrites and create files with mode 0600.

The manual fallback captures overlapping evidence at least twice daily, before the one-day
attempt cleanup can remove receipt timestamps. Use a new filename for
every capture. From `web`, with the production administration environment
loaded locally:

```sh
node scripts/ops/export-dogfood.ts --confirm-export-private-evidence \
  --monitors '<first-uuid>,<second-uuid>' \
  --from '<UTC-window-start>' --to '<UTC-window-end>' \
  --output /private/monitrail-proof/new-snapshot.json
```

The exporter is read-only. It exports selected IDs, revisions, interval,
pause state, lifecycle events, incidents and allowlisted observations. It
excludes names, URLs, account information, channels and credentials. The
server acceptance timestamp comes from successful attempts, not the
Worker's clock. If a receipt has already expired, the export marks it
missing. Earlier overlapping exports can supply retained evidence.

Prepare a private JSON manifest with `version: 1`, `startAt`, exactly two
`monitors` entries containing `id`, `configRev` and `intervalSeconds: 300`.
An optional `configChanges` journal records `{id, monitorId, at}`. Record
every configuration edit there, including an edit later reverted between
snapshots. Historical interval-only edits are not reconstructible from
the application schema. Do not assume unchanged settings from one final
snapshot alone.

Maintain a private reviews JSON file with `version: 1` and `reviews`
containing `{incidentId, verdict}` entries. Verdicts are `real`, `false`
or `unresolved`. Review every overlapping incident against independent
site evidence. Keep investigation notes private. An unreviewed incident
cannot establish zero false incidents.

```sh
node web/scripts/ops/score-dogfood.ts \
  --manifest /private/monitrail-proof/manifest.json \
  --evidence /private/monitrail-proof/first.json,/private/monitrail-proof/second.json \
  --reviews /private/monitrail-proof/reviews.json \
  --as-of '<current-UTC-instant>' \
  --output /private/monitrail-proof/new-report.json
```

The scorer uses fixed five-minute slots from the proof start. Each accepted
result can fill one slot, assigned to the earliest eligible unfilled slot.
The slot includes a 60-second grace period. A received failure is still a
recorded check. Paused-slot intersections are excluded. Each mature
24-hour day requires strictly less than 1% missed slots per monitor and
across the fleet, using integer comparisons. A day with no active slots
cannot pass. Configuration changes require a restart.

Evidence query windows are half-open. For the final slot's inclusive
grace cutoff, the final export and assessment must extend beyond
`proof start + 14 days + 60 seconds`. The extra instant closes the evidence
window and adds no scheduling grace. A missing capture or receipt produces
an incomplete result. A failed day restarts the 14-day count after the fix.
The evaluator cannot create elapsed operating time from fixture tests.

Exit status is 0 for passed, 2 for incomplete, and 1 for failed, restart
required or invalid input. Keep private snapshots and reports backed up.
The current scheduler uses acceptance-relative next checks; the approved
fixed-slot proof may reveal cadence failures. Do not change scheduling or
relax the measurement to hide them.

## Completion evidence

Record three anonymous human trials as A, B and C, with start and first
healthy-result timestamps and elapsed seconds. Each must be under two
minutes. Automated browser fixtures do not substitute for these trials.

After 14 real clean days and all incident reviews, write the short case
study using measured results, the deployed revision and the exact proof
window. Do not mark Phase 11 complete before this evidence exists.
