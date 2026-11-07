import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { fixtureOwners } from "../db/fixtures.ts";
import { readAuthConfig } from "../../src/auth/config.ts";
import {
  assertFixtureSessionProjection,
  assertFixtureSessionRevoked,
  fixtureCookie,
  insertRevocationAccount,
  insertSeededOwnerSession,
  newFixtureSession,
  openFixtureDatabase,
  removeFixtureSession,
  removeRevocationAccount,
  type FixtureDatabase,
  type FixtureSession,
} from "./fixture-session.ts";

const baseURL = "https://localhost:3443";
const webDirectory = fileURLToPath(new URL("../../", import.meta.url));
let stage = "configuration";
let database: FixtureDatabase | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: Server | undefined;
let child: ChildProcess | undefined;
let certificateDirectory: string | undefined;
let temporarySession: FixtureSession | undefined;
let temporaryAccountId: string | undefined;
const errors: string[] = [];
const origins = new Set<string>();
const requestDiagnostics: { stage: string; path: string; type: string; navigation: boolean; rsc: boolean; prefetch: boolean; failure: string }[] = [];
const expectedCancellations = { prefetch: 0, disabledScript: 0 };

function observe(page: Page, javaScriptEnabled = true): void {
  page.on("pageerror", () => errors.push("page error"));
  page.on("console", message => { if (message.type() === "error") errors.push("console error"); });
  page.on("requestfailed", request => {
    const pathname = new URL(request.url()).pathname;
    const safePath = ["/", "/login", "/dashboard", "/settings", "/channels", "/status-pages", "/api/auth/get-session", "/api/auth/sign-out"].includes(pathname) ? pathname : pathname.startsWith("/_next/") ? "Next asset" : "other";
    const headers = request.headers();
    const failure = request.failure()?.errorText ?? "unknown";
    // Next cancels speculative RSC prefetches on navigation. They are not
    // required documents/assets/auth calls, all of which remain fatal below.
    if (failure === "net::ERR_ABORTED" && request.method() === "GET" && new URL(request.url()).origin === baseURL && request.resourceType() === "fetch" && !request.isNavigationRequest() &&
      headers.rsc === "1" && headers["next-router-prefetch"] === "1" &&
      ["/", "/login", "/dashboard", "/settings", "/channels", "/status-pages"].includes(pathname)) {
      expectedCancellations.prefetch++;
      return;
    }
    // An isolated fixture reproduces Chromium's "csp" failure when JavaScript
    // is deliberately disabled. Every other asset/document/auth failure counts.
    if (!javaScriptEnabled && request.resourceType() === "script" && failure === "csp") {
      expectedCancellations.disabledScript++;
      return;
    }
    requestDiagnostics.push({ stage, path: safePath, type: request.resourceType(), navigation: request.isNavigationRequest(), rsc: headers.rsc === "1", prefetch: headers["next-router-prefetch"] === "1", failure: failure.match(/^net::[A-Z_]+/)?.[0] ?? "other" });
    errors.push(failure === "net::ERR_ABORTED" ? "aborted request" : "failed request");
  });
  page.on("request", request => origins.add(new URL(request.url()).origin));
  page.on("response", response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()}`); });
}

try {
  if (!process.argv.includes("--confirm-fixture-session") || process.env.NODE_ENV === "production") throw new Error();
  // The tested server still applies production HTTPS validation. The configured
  // development origin is overridden only in this test process and its child.
  const config = readAuthConfig({ ...process.env, APP_URL: baseURL }, true);
  assert(existsSync(join(webDirectory, ".next/BUILD_ID")));

  stage = "temporary local TLS setup";
  certificateDirectory = mkdtempSync(join(tmpdir(), "monitrail-phase3b-tls-"));
  const keyPath = join(certificateDirectory, "private-key.pem");
  const certificatePath = join(certificateDirectory, "certificate.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-keyout", keyPath, "-out", certificatePath, "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ], { stdio: "ignore", timeout: 10000 });
  chmodSync(keyPath, 0o600);
  server = createServer({ key: readFileSync(keyPath), cert: readFileSync(certificatePath) }, (incoming, outgoing) => {
    const upstream = httpRequest({
      hostname: "127.0.0.1", port: 3001, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: "localhost:3443", "x-forwarded-host": "localhost:3443", "x-forwarded-proto": "https" },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("error", () => {
      if (outgoing.destroyed) return;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.on("error", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    outgoing.on("error", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server?.once("error", reject);
    server?.listen(3443, "localhost", resolve);
  });

  stage = "production server startup";
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APP_URL: baseURL,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  delete childEnv.MIGRATION_DATABASE_URL;
  child = spawn(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url)),
    "start", "--hostname", "127.0.0.1", "--port", "3001",
  ], {
    cwd: webDirectory,
    env: childEnv,
    stdio: "ignore",
  });
  child.on("error", () => errors.push("server startup error"));
  browser = await chromium.launch({ headless: true, ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}) });
  // Certificate trust is relaxed only in this local verification browser.
  // The application's production HTTPS and secure-cookie settings stay intact.
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null || errors.length) throw new Error();
    try {
      ready = (await anonymous.request.get(baseURL, { timeout: 1000 })).status() === 200;
      if (ready) break;
    } catch { /* The child may still be starting. */ }
    await delay(150);
  }
  assert(ready);

  stage = "short-lived synthetic secure session";
  database = openFixtureDatabase();
  const [owner] = fixtureOwners;
  const session = newFixtureSession(owner.id);
  temporarySession = session;
  await insertSeededOwnerSession(database, session);
  const cookie = fixtureCookie(baseURL, session);

  stage = "production anonymous route redirects";
  for (const path of ["/dashboard", "/channels", "/status-pages", "/settings", "/monitors/new", `/monitors/${fixtureOwners[1].monitorId}`]) {
    const response = await anonymous.request.get(`${baseURL}${path}`, { maxRedirects: 0 });
    assert.equal(response.status(), 307);
    const destination = new URL(response.headers().location, baseURL);
    assert.equal(destination.origin, baseURL);
    assert.equal(destination.pathname, "/login");
    assert.equal(destination.searchParams.get("next"), path);
  }
  assert.equal(await (await anonymous.request.get(`${baseURL}/api/auth/get-session`)).json(), null);

  stage = "production public responsive layout";
  const page = await anonymous.newPage();
  observe(page);
  for (const width of [360, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of ["/", "/login"]) {
      assert.equal((await page.goto(`${baseURL}${path}`, { waitUntil: "networkidle" }))?.status(), 200);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  assert.equal(await page.getByRole("button", { name: "Continue with GitHub" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Continue with Google" }).count(), 1);
  assert.equal(await page.getByLabel("Invitation code").count(), config.signupMode === "invite" ? 1 : 0);
  await anonymous.close();

  stage = "production secure-cookie storage";
  const authenticated = await browser.newContext({ ignoreHTTPSErrors: true });
  await authenticated.addCookies([cookie]);
  const storedCookie = (await authenticated.cookies(baseURL)).find(item => item.name === cookie.name);
  assert.equal(storedCookie?.secure, true);
  assert.equal(storedCookie?.httpOnly, true);
  assert.equal(storedCookie?.sameSite, "Lax");
  stage = "production sanitized session and secure cookie issuance";
  await assertFixtureSessionProjection(database, session, () =>
    authenticated.request.get(`${baseURL}/api/auth/get-session`, { maxRedirects: 0 }),
    cookie.name,
  );
  stage = "production authenticated dashboard HTTP response";
  const dashboard = await authenticated.request.get(`${baseURL}/dashboard`, { maxRedirects: 0 });
  if (dashboard.status() !== 200) {
    console.error(`Authenticated dashboard status: ${dashboard.status()}.`);
    throw new Error();
  }
  const privatePage = await authenticated.newPage();
  observe(privatePage);
  stage = "production dashboard navigation at 360 px";
  await privatePage.setViewportSize({ width: 360, height: 800 });
  const response = await privatePage.goto(`${baseURL}/dashboard`, { waitUntil: "domcontentloaded" });
  if (response?.status() !== 200) {
    console.error(`Dashboard document status: ${response?.status() ?? "unavailable"}.`);
    throw new Error();
  }
  for (const width of [360, 1440]) {
    stage = `production dashboard owner layout at ${width} px`;
    await privatePage.setViewportSize({ width, height: 800 });
    await privatePage.getByRole("heading", { name: "Dashboard", exact: true }).waitFor();
    assert.equal(await privatePage.getByRole("heading", { name: "Dashboard", exact: true }).count(), 1);
    assert(await privatePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await privatePage.locator(".monitor-row").count(), 1);
    assert(!(await privatePage.content()).includes("demo-2.example.invalid"));
    if (width === 360) await privatePage.screenshot({ path: "/tmp/monitrail-phase3b-production-dashboard-360.png", fullPage: true });
  }
  stage = "production settings owner identity";
  const settings = await authenticated.request.get(`${baseURL}/settings`, { maxRedirects: 0 });
  assert.equal(settings.status(), 200);
  assert((await settings.text()).includes(owner.email));

  stage = "production HTML without JavaScript";
  const noJavaScript = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  await noJavaScript.addCookies([cookie]);
  const htmlPage = await noJavaScript.newPage();
  observe(htmlPage, false);
  assert.equal((await htmlPage.goto(`${baseURL}/dashboard`, { waitUntil: "domcontentloaded" }))?.status(), 200);
  assert.equal(await htmlPage.getByRole("heading", { name: "Dashboard", exact: true }).count(), 1);
  assert.equal(await htmlPage.locator(".monitor-row").count(), 1);
  assert(await htmlPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await noJavaScript.close();

  stage = "production logout revocation";
  const signOutResponse = privatePage.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/sign-out" && response.request().method() === "POST");
  await privatePage.getByRole("button", { name: "Sign out", exact: true }).click();
  const logout = await signOutResponse;
  stage = "production logout response status";
  assert.equal(logout.status(), 200);
  const clearingCookies = (await logout.headersArray()).filter(header => header.name.toLowerCase() === "set-cookie").map(header => header.value);
  stage = "production logout cookie clearing";
  assert(clearingCookies.some(value => value.startsWith(`${cookie.name}=`) && /;\s*Secure(?:;|$)/i.test(value) && /;\s*HttpOnly(?:;|$)/i.test(value)));
  stage = "production logout landing navigation";
  await privatePage.waitForURL(`${baseURL}/`);
  stage = "production logout protected redirect";
  assert.equal((await authenticated.request.get(`${baseURL}/dashboard`, { maxRedirects: 0 })).status(), 307);
  stage = "production logout persisted revocation";
  await assertFixtureSessionRevoked(database, session);
  stage = "production logout browser revocation";
  assert(!(await authenticated.cookies(baseURL)).some(item => item.name === cookie.name));
  await authenticated.close();

  stage = "production account deletion revokes the existing session cookie";
  const deletionSession = newFixtureSession(randomUUID());
  temporaryAccountId = deletionSession.userId;
  await insertRevocationAccount(database, deletionSession);
  const deletion = await browser.newContext({ ignoreHTTPSErrors: true });
  await deletion.addCookies([fixtureCookie(baseURL, deletionSession)]);
  assert.equal((await deletion.request.get(`${baseURL}/dashboard`, { maxRedirects: 0 })).status(), 200);
  assert.equal(await removeRevocationAccount(database, deletionSession.userId), 1);
  await assertFixtureSessionRevoked(database, deletionSession);
  assert.equal((await deletion.request.get(`${baseURL}/dashboard`, { maxRedirects: 0 })).status(), 307);
  const deletedSession = await deletion.request.get(`${baseURL}/api/auth/get-session`, { maxRedirects: 0 });
  assert.equal(deletedSession.status(), 200);
  assert.equal(await deletedSession.json(), null);
  await deletion.close();

  stage = "production browser errors and external requests";
  if (errors.length) console.error(`Browser check categories: ${JSON.stringify(errors.reduce<Record<string, number>>((counts, value) => { counts[value] = (counts[value] ?? 0) + 1; return counts; }, {}))}`);
  if (requestDiagnostics.length) console.error(`Safe request diagnostics: ${JSON.stringify(requestDiagnostics)}`);
  assert.deepEqual(errors, []);
  assert.deepEqual([...origins], [baseURL]);
  console.log(`Expected browser cancellations: ${expectedCancellations.prefetch} speculative RSC prefetches; ${expectedCancellations.disabledScript} scripts blocked only in the JavaScript-disabled context.`);
  console.log("Phase 3b production acceptance passed: real production build behind local HTTPS, secure HttpOnly cookies, protected redirects, owner-only layouts at 360/1440 px, no browser errors/failed required requests/external requests, HTML without JavaScript, sanitized session DTO and revocation on logout and account deletion.");
} catch (error) {
  const category = error instanceof Error && error.name === "TimeoutError" ? "timeout" :
    error instanceof Error ? error.message.match(/net::[A-Z_]+/)?.[0] : undefined;
  if (category) console.error(`Browser failure category: ${category}.`);
  console.error(`Phase 3b production acceptance failed during ${stage}; credential values and raw errors were not displayed.`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  catch { console.error("Production browser cleanup failed."); process.exitCode = 1; }
  if (database && temporarySession) {
    try { await removeFixtureSession(database, temporarySession); }
    catch { console.error("Temporary fixture-session cleanup failed; review the disposable project."); process.exitCode = 1; }
  }
  if (database && temporaryAccountId) {
    try { await removeRevocationAccount(database, temporaryAccountId); }
    catch { console.error("Temporary revocation-account cleanup failed; review the disposable project."); process.exitCode = 1; }
  }
  try { await database?.end({ timeout: 5 }); }
  catch { console.error("Production fixture connection cleanup failed."); process.exitCode = 1; }
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const serverProcess = child;
    const stopped = new Promise<boolean>(resolve => serverProcess.once("exit", () => resolve(true)));
    serverProcess.kill("SIGTERM");
    if (!(await Promise.race([stopped, delay(2000, false)]))) {
      serverProcess.kill("SIGKILL");
      if (!(await Promise.race([stopped, delay(2000, false)]))) {
        console.error("Production test server did not exit.");
        serverProcess.unref();
        process.exitCode = 1;
      }
    }
  }
  if (certificateDirectory) rmSync(certificateDirectory, { recursive: true, force: true });
}
