# Phase 0 — setup and verification

Date: 2026-11-01. Scope: Phase 0 only; Phase 1 has not started.

## Changes

- Initialized Git on `phase/0-setup` and set the local author/committer alias
  to `Monitrail <dev@monitrail.invalid>` before the first commit. The initial
  commit preserves the supplied documents as a review baseline.
- Added npm workspaces for `web/` and `checker/`, a shared-module placeholder,
  exact dependency pins, a root lockfile, ignore rules and names-only
  environment inventories. No real credentials are required for setup.
- Added a minimal Next.js App Router page using the documented dark palette
  and system-font fallback, plus a local SVG browser icon to avoid a missing
  favicon request. It has no application flows or product promises.
- Added an inert Worker entry point and a local Wrangler dry-run build.
  There are no cron triggers, outbound requests, database bindings, auth,
  guard, HMAC or state-machine implementations in this phase.
  Its compatibility date is 2026-10-30, the newest date supported by the
  workerd binary bundled with the pinned Wrangler release. A runtime smoke
  check caught that using the task date (2026-11-01) was too new for it.
- Configured strict TypeScript checking, Biome and empty Vitest runs in both
  packages. Next.js route types and Worker runtime types are generated before
  their respective typechecks. Application and security tests remain future
  work; empty-run success is not evidence of application correctness.

## Dependency verification before installation

Queried npm registry metadata on the date above and read the official setup
documentation before installation. Direct dependencies are exact versions;
the root `package-lock.json` records the transitive graph and integrity hashes.

| Dependency | Selected version | Purpose / compatibility decision |
| --- | --- | --- |
| next | 16.4.3 | Current stable App Router |
| react / react-dom | 19.3.1 | Current stable React pair supported by Next.js |
| tailwindcss / @tailwindcss/postcss | 4.3.3 | Current stable styling toolchain required by doc 02 |
| postcss | 8.5.32 | Current stable host for the documented Tailwind PostCSS plugin |
| typescript | 7.0.2 | Current stable native compiler, supported by Next.js's documented default CLI typecheck |
| @biomejs/biome | 2.6.4 | Current stable linter, supported by Next.js; recommended TypeScript/React/Next rules without the ESLint dependency chain |
| @types/node | 24.19.2 | Latest 24.x types, matching the selected Node runtime major rather than latest overall 26.6.6 |
| @types/react / @types/react-dom | 19.3.0 | Current stable React type declarations |
| vitest | 5.0.5 | Current stable unit-test runner; Node 24 meets its engine requirement |
| wrangler | 4.156.0 | Current stable Worker bundler, local runtime and runtime-type generator |
| @playwright/test | 1.64.1 | Current stable browser tooling for the required responsive and console smoke check |

Node 24.12.0 and npm 11.6.2 are the available, tested runtime versions.
No database, ORM, auth, charting or alert-delivery packages are installed.
Gitleaks 8.30.1 is used only as a temporary verification CLI, downloaded from
its official release and verified against the release SHA-256 checksum.

Official references consulted:

- [Next.js installation](https://nextjs.org/docs/app/getting-started/installation)
  and [TypeScript 7 support](https://nextjs.org/docs/app/api-reference/config/typescript)
- [Next.js CLI bundler switches](https://nextjs.org/docs/app/api-reference/cli/next)
- [React installation](https://react.dev/learn/installation)
- [Tailwind PostCSS setup](https://tailwindcss.com/docs/installation/using-postcss)
- [TypeScript configuration](https://www.typescriptlang.org/docs/handbook/tsconfig-json.html)
- [Biome setup](https://biomejs.dev/installation/quick-start/),
  [configuration](https://biomejs.dev/reference/configuration/),
  and [Next.js rules](https://biomejs.dev/linter/domains/#next)
- [Vitest setup](https://vitest.dev/guide/)
  and [empty-suite behavior](https://vitest.dev/config/passwithnotests)
- [Wrangler build/type commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)
- [Playwright setup](https://playwright.dev/docs/intro)
- [Gitleaks commands](https://github.com/gitleaks/gitleaks)
  and [pinned release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1)

## Provider assumptions checked; later-phase decisions remain open

- [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/)
  currently list five free Cron Triggers per account, 50 external subrequests
  per invocation, six simultaneous connections waiting for headers, and
  10 ms CPU per free Cron invocation. [Cron syntax](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  supports minute-level scheduling. DNS validation and redirects must count
  toward the request budget; the TRD's 200-monitor estimate is not validated.
- [Vercel Hobby cron](https://vercel.com/docs/cron-jobs/usage-and-pricing)
  is limited to once per day, with up to an hour of scheduling imprecision.
  [Hobby use restrictions](https://vercel.com/docs/limits/fair-use-guidelines)
  require review before operating a service for commercial client work.
- [Neon Free](https://neon.com/blog/neon-free-plan-1-gb-per-project)
  currently provides 1 GB database storage and 100 CU-hours per project per
  month. [Scale to zero](https://neon.com/docs/introduction/scale-to-zero)
  requires five idle minutes. Inference: continuous minute-by-minute polling
  keeps compute awake; 0.25 CU over 30 days would consume 180 CU-hours. This
  needs an owner-approved architectural resolution before database work;
  Phase 0 neither creates a database nor changes the chosen provider.
- [Auth.js installation](https://authjs.dev/getting-started/installation)
  still documents `next-auth@beta` for the App Router; its site also links
  migration guidance for Better Auth. Phase 2 must resolve the stable-version
  and library choice before installing auth or designing adapter tables.
- The preceding specification review's security, lifecycle, quotas,
  delivery-guarantee and product decisions remain unresolved for their
  implementation phases. They are not claimed fixed by this scaffold.
- No Ruflo tools are exposed in the current tool inventory, and the project's
  `.agents/` directory contains no skills or MCP configuration. No external
  agent skills, plugins or MCP servers were installed or invoked.

## Verification results

All checks below were run successfully before marking Phase 0 complete.

| Check | Web | Checker |
| --- | --- | --- |
| `npm run build` in each package | PASS: optimized static Next.js production build, including local icon | PASS: Wrangler dry run, 0.17 KiB, no bindings, no deployment |
| `npm run lint` (root runs both package scripts) | PASS: Biome, 9 files, no errors or warnings | PASS: Biome, 5 files, no errors or warnings |
| `npm run typecheck` (root runs both package scripts) | PASS: route type generation and native TypeScript 7 | PASS: runtime type generation and native TypeScript 7; rerun after compatibility-date fix |
| `npm test` (root runs both package scripts) | PASS: empty Vitest run, zero tests, exit 0 | PASS: empty Vitest run, zero tests, exit 0 |

Additional checks:

- Clean `npm ci --no-fund` from the lockfile: PASS, zero reported
  vulnerabilities. `npm ls --all`: exit 0, no invalid/missing peer errors.
- Every direct dependency uses an exact version matching the lockfile.
  No ESLint, typescript-eslint or minimatch packages remain in that lockfile.
- Both `.env.example` inventories match doc 02's names exactly and contain
  no assignments or values. `git check-ignore` confirmed that local secrets,
  generated types, builds and agent runtime state are ignored while the
  two example inventories remain eligible for tracking.
- Gitleaks 8.30.1 found no secrets in the initial Git history or a snapshot
  of all tracked and eligible new files. The completed history is rescanned
  after the setup commit. No real credentials were created for this phase.
- Browser verification used Playwright with installed Chromium against the
  final production build at 360 x 800 and 1440 x 800. Both returned HTTP 200;
  document scroll widths equaled viewport widths. The title, English language
  attribute and documented canvas color were correct. Zero console/page
  errors, failed asset responses or external browser requests were observed.
  The basic content also rendered with JavaScript disabled. A 360 px
  screenshot was inspected; its local verification copy is
  `/tmp/monitrail-phase0-web-360.png` and is not committed.
- Local Worker runtime smoke check: PASS, empty HTTP 404 response. The local
  test processes were stopped after checking. There is no scheduled handler.
- Independent second-model review by `gpt-6-astra`: approved for Phase 0
  with no actionable findings after reviewing the final scaffold and supplied
  build, lint, typecheck, test, dependency, secret and browser evidence.
- Git is on `phase/0-setup`; the project alias was configured before the
  baseline commit and author/committer metadata was verified. The original
  six specifications remain unchanged except Phase 0's completed checkbox
  and this verification link in doc 06. Phase 1 remains unchecked/unstarted.

Non-blocking tooling observation: npm emitted Node's `DEP0169` deprecation
warning during some commands. Application lint had no warnings and the
production browser had no console errors. No application code uses
`url.parse()`.

## Fixes made during verification

The first dependency audit found 16 moderate findings propagated from
`minimatch` in the ESLint toolchain. ESLint 9 was also marked unsupported,
while the current framework plugins did not all accept ESLint 10 peers.
The final scaffold uses Biome, an officially supported Next.js lint option,
and removes that dependency chain. No forced upgrades or advisory suppression
are used. The earlier TypeScript 6 compatibility constraint was tied to
typescript-eslint; removing it allows the current TypeScript 7 compiler.

Turbopack's PostCSS subprocess could not bind its required local port in this
execution environment, including an elevated attempt. The final web dev/build
scripts use the officially documented `--webpack` option. Production build
verification uses that supported mode, without disabling TypeScript checking.
Wrangler's dry-run build and type generation need access to its normal local
cache outside the workspace; those checks were run with that access. No
deployment was performed.
