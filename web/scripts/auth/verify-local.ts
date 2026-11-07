import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "@playwright/test";
import { fixtureOwners } from "../db/fixtures.ts";
import { readAuthConfig } from "../../src/auth/config.ts";
import {
  assertFixtureSessionProjection,
  assertFixtureSessionRevoked,
  fixtureCookie,
  insertSeededOwnerSession,
  newFixtureSession,
  openFixtureDatabase,
  removeFixtureSession,
  type FixtureDatabase,
  type FixtureSession,
} from "./fixture-session.ts";

let stage = "configuration";
let database: FixtureDatabase | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let temporarySession: FixtureSession | undefined;
try {
  if (!process.argv.includes("--confirm-fixture-session") || process.env.NODE_ENV === "production") throw new Error();
  const config = readAuthConfig(process.env);
  const app = new URL(config.baseURL);
  if (app.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(app.hostname)) throw new Error();
  stage = "synthetic fixture session";
  database = openFixtureDatabase();
  const [owner] = fixtureOwners;
  const session = newFixtureSession(owner.id);
  temporarySession = session;
  await insertSeededOwnerSession(database, session);
  const cookie = fixtureCookie(config.baseURL, session);
  browser = await chromium.launch({ headless: true, ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}) });
  const anonymous = await browser.newContext();
  stage = "unauthenticated route protection";
  for (const path of ["/dashboard", "/channels", "/status-pages", "/settings", "/monitors/new", `/monitors/${fixtureOwners[1].monitorId}`]) {
    stage = `protected route ${path}`;
    const response = await anonymous.request.get(`${config.baseURL}${path}`, { maxRedirects: 0 });
    stage = `protected response status ${path}`;
    assert.equal(response.status(), 307);
    const location = new URL(response.headers().location, config.baseURL);
    stage = `protected redirect origin ${path}`;
    assert.equal(location.origin, config.baseURL);
    stage = `protected redirect destination ${path}`;
    assert.equal(location.pathname, "/login");
    stage = `protected return path ${path}`;
    assert.equal(location.searchParams.get("next"), path);
  }
  stage = "forged session rejection";
  const forged = await browser.newContext();
  await forged.addCookies([{ ...cookie, value: "forged.invalid" }]);
  assert.equal((await forged.request.get(`${config.baseURL}/dashboard`, { maxRedirects: 0 })).status(), 307);
  await forged.close();
  stage = "anonymous public session";
  const publicSession = await anonymous.request.get(`${config.baseURL}/api/auth/get-session`);
  assert.equal(await publicSession.json(), null);
  for (const path of ["get-access-token", "list-accounts", "link-social", "update-user"]) {
    stage = `restricted authentication endpoint ${path}`;
    assert.equal((await anonymous.request.post(`${config.baseURL}/api/auth/${path}`, { headers: { origin: config.baseURL }, data: {} })).status(), 404);
  }
  stage = "foreign-origin rejection";
  assert.equal((await anonymous.request.post(`${config.baseURL}/api/auth/sign-in/social`, { headers: { origin: "https://evil.example" }, data: { provider: "github" } })).status(), 403);

  stage = "public browser layout";
  const page = await anonymous.newPage();
  const errors: string[] = [];
  const origins = new Set<string>();
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  page.on("request", request => origins.add(new URL(request.url()).origin));
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/", "/login?next=%2Fchannels"]) {
      assert.equal((await page.goto(`${config.baseURL}${path}`, { waitUntil: "networkidle" }))?.status(), 200);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  assert.equal(await page.getByRole("button", { name: "Continue with GitHub" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).count(), 1);
  assert.equal(await page.getByLabel("Invitation code").count(), config.signupMode === "invite" ? 1 : 0);
  await page.keyboard.press("Tab");
  assert(await page.locator(":focus-visible").count() > 0);
  await anonymous.close();

  stage = "authenticated owner-scoped browser layout";
  const authenticated = await browser.newContext();
  await authenticated.addCookies([cookie]);
  const privatePage = await authenticated.newPage();
  privatePage.on("pageerror", () => errors.push("private page error"));
  privatePage.on("console", message => { if (message.type() === "error") errors.push("private console error"); });
  privatePage.on("request", request => origins.add(new URL(request.url()).origin));
  for (const width of [360, 1440]) {
    await privatePage.setViewportSize({ width, height: 800 });
    assert.equal((await privatePage.goto(`${config.baseURL}/dashboard`, { waitUntil: "networkidle" }))?.status(), 200);
    assert.equal(await privatePage.getByRole("heading", { name: "Dashboard", exact: true }).count(), 1);
    assert(await privatePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await privatePage.locator(".monitor-row").count(), 1);
    assert(!(await privatePage.content()).includes("demo-2.example.invalid"));
    if (width === 360) await privatePage.screenshot({ path: "/tmp/monitrail-phase3b-dashboard-360.png", fullPage: true });
  }
  await privatePage.goto(`${config.baseURL}/settings`, { waitUntil: "networkidle" });
  assert((await privatePage.textContent("main"))?.includes(owner.email));
  stage = "sanitized session projection";
  await assertFixtureSessionProjection(database, session, () =>
    authenticated.request.get(`${config.baseURL}/api/auth/get-session`, { maxRedirects: 0 }),
  );

  stage = "logout and revoked session";
  await privatePage.getByRole("button", { name: "Sign out", exact: true }).click();
  await privatePage.waitForURL(`${config.baseURL}/`);
  assert.equal((await authenticated.request.get(`${config.baseURL}/dashboard`, { maxRedirects: 0 })).status(), 307);
  await assertFixtureSessionRevoked(database, session);
  assert.deepEqual(errors, []);
  assert.deepEqual([...origins], [config.baseURL]);
  console.log("Phase 3b local acceptance passed: protected redirects, forged-session rejection, token endpoint restrictions, owner-scoped authenticated UI at 360/1440 px, no browser errors/external requests, and logout revocation. Temporary synthetic session removed.");
} catch (error) {
  const category = error instanceof Error && error.name === "AssertionError" ? "assertion" : "runtime";
  console.error(`Phase 3b local acceptance failed during ${stage} (${category}); credential values and raw errors were not displayed.`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  catch { console.error("Local browser cleanup failed."); process.exitCode = 1; }
  if (database && temporarySession) {
    try { await removeFixtureSession(database, temporarySession); }
    catch { console.error("Temporary fixture-session cleanup failed; review the disposable project."); process.exitCode = 1; }
  }
  try { await database?.end({ timeout: 5 }); }
  catch { console.error("Local fixture connection cleanup failed."); process.exitCode = 1; }
}
