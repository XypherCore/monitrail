import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import { makeSignature } from "better-auth/crypto";
import { drizzle } from "drizzle-orm/neon-serverless";
import { openNeonPool } from "../db/connection.ts";
import { fixtureOwners } from "../db/fixtures.ts";
import { readAuthConfig } from "../../src/auth/config.ts";
import { createAuthCore } from "../../src/auth/core.ts";

const baseURL = "https://localhost:3443";
const webDirectory = fileURLToPath(new URL("../../", import.meta.url));
let stage = "configuration";
let pool: ReturnType<typeof openNeonPool> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: Server | undefined;
let child: ChildProcess | undefined;
let certificateDirectory: string | undefined;
let temporarySessionId: string | undefined;
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
  certificateDirectory = mkdtempSync(join(tmpdir(), "monitrail-phase2-tls-"));
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
  child = spawn(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url)),
    "start", "--hostname", "127.0.0.1", "--port", "3001",
  ], {
    cwd: webDirectory,
    env: { ...process.env, APP_URL: baseURL, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
  });
  child.on("error", () => errors.push("server startup error"));
  browser = await chromium.launch({ headless: true, ...(existsSync("/usr/bin/chromium") ? { executablePath: "/usr/bin/chromium" } : {}) });
  // Certificate trust is relaxed only in this local verification browser.
  // The application's production HTTPS and secure-cookie settings stay intact.
  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null || errors.length) throw new Error();
    try {
      ready = (await anonymous.request.get(baseURL, { timeout: 1000 })).status() === 200;
      if (ready) break;
    } catch { /* The child may still be starting. */ }
    await delay(150);
  }
  assert(ready);

  stage = "synthetic fixture identity verification";
  pool = openNeonPool();
  const owner = fixtureOwners[0];
  const users = await pool.query("SELECT id FROM users WHERE id=$1 AND email=$2 AND name=$3", [owner.id, owner.email, owner.name]);
  assert.equal(users.rows.length, 1);
  const monitors = await pool.query("SELECT id,name,url FROM monitors WHERE user_id=$1", [owner.id]);
  assert.equal(monitors.rows.length, 1);
  assert.equal(monitors.rows[0].id, owner.monitorId);
  assert.equal(monitors.rows[0].name, "Demo site 1");
  assert.equal(monitors.rows[0].url, "https://demo-1.example.invalid");

  stage = "short-lived synthetic secure session";
  const context = await createAuthCore(drizzle(pool), config).$context;
  const session = await context.internalAdapter.createSession(owner.id, true, { expiresAt: new Date(Date.now() + 600000) }, true);
  if (!session) throw new Error();
  temporarySessionId = session.id;
  assert(session.expiresAt.getTime() <= Date.now() + 600000);
  const sessionCookie = context.authCookies.sessionToken;
  assert.equal(sessionCookie.attributes.secure, true);
  assert.equal(sessionCookie.attributes.httpOnly, true);
  assert(sessionCookie.name.startsWith("__Secure-"));
  const cookie = {
    name: sessionCookie.name,
    value: encodeURIComponent(`${session.token}.${await makeSignature(session.token, config.secret)}`),
    url: baseURL, httpOnly: true, secure: true, sameSite: "Lax" as const,
  };
  // Prevent the short-lived administrative fixture from being extended by the
  // normal session-renewal endpoint; renewal itself has a separate regression test.
  const remember = context.authCookies.dontRememberToken;
  const rememberCookie = {
    ...cookie, name: remember.name,
    value: encodeURIComponent(`true.${await makeSignature("true", config.secret)}`),
  };

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
  await anonymous.close();

  stage = "production secure-cookie owner access";
  const authenticated = await browser.newContext({ ignoreHTTPSErrors: true });
  await authenticated.addCookies([cookie, rememberCookie]);
  const storedCookie = (await authenticated.cookies(baseURL)).find(item => item.name === cookie.name);
  assert.equal(storedCookie?.secure, true);
  assert.equal(storedCookie?.httpOnly, true);
  assert.equal(storedCookie?.sameSite, "Lax");
  const privatePage = await authenticated.newPage();
  observe(privatePage);
  for (const width of [360, 1440]) {
    await privatePage.setViewportSize({ width, height: 800 });
    assert.equal((await privatePage.goto(`${baseURL}/dashboard`, { waitUntil: "networkidle" }))?.status(), 200);
    assert.equal(await privatePage.getByRole("heading", { name: "Dashboard", exact: true }).count(), 1);
    assert(await privatePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.equal(await privatePage.locator(".monitor-row").count(), 1);
    assert(!(await privatePage.content()).includes("demo-2.example.invalid"));
    if (width === 360) await privatePage.screenshot({ path: "/tmp/monitrail-phase2-production-dashboard-360.png", fullPage: true });
  }
  await privatePage.goto(`${baseURL}/settings`, { waitUntil: "networkidle" });
  assert((await privatePage.textContent("main"))?.includes(owner.email));
  const safeResponse = await authenticated.request.get(`${baseURL}/api/auth/get-session`);
  assert.equal(safeResponse.status(), 200);
  const safeText = await safeResponse.text();
  assert(!safeText.includes(session.token));
  const safe = JSON.parse(safeText);
  assert.deepEqual(Object.keys(safe).sort(), ["session", "user"]);
  assert.deepEqual(Object.keys(safe.session), ["expiresAt"]);
  assert.deepEqual(Object.keys(safe.user).sort(), ["email", "id", "name"]);

  stage = "production HTML without JavaScript";
  const noJavaScript = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false, viewport: { width: 360, height: 800 } });
  await noJavaScript.addCookies([cookie, rememberCookie]);
  const htmlPage = await noJavaScript.newPage();
  observe(htmlPage, false);
  assert.equal((await htmlPage.goto(`${baseURL}/dashboard`, { waitUntil: "networkidle" }))?.status(), 200);
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
  assert.equal((await pool.query("SELECT id FROM sessions WHERE id=$1 AND user_id=$2", [session.id, owner.id])).rows.length, 0);
  stage = "production logout browser revocation";
  assert(!(await authenticated.cookies(baseURL)).some(item => item.name === cookie.name));
  await authenticated.close();
  stage = "production browser errors and external requests";
  if (errors.length) console.error(`Browser check categories: ${JSON.stringify(errors.reduce<Record<string, number>>((counts, value) => { counts[value] = (counts[value] ?? 0) + 1; return counts; }, {}))}`);
  if (requestDiagnostics.length) console.error(`Safe request diagnostics: ${JSON.stringify(requestDiagnostics)}`);
  assert.deepEqual(errors, []);
  assert.deepEqual([...origins], [baseURL]);
  console.log(`Expected browser cancellations: ${expectedCancellations.prefetch} speculative RSC prefetches; ${expectedCancellations.disabledScript} scripts blocked only in the JavaScript-disabled context.`);
  console.log("Phase 2 production acceptance passed: real production build behind local HTTPS, secure HttpOnly cookies, protected redirects, owner-only layouts at 360/1440 px, no browser errors/failed required requests/external requests, HTML without JavaScript, sanitized session DTO and logout revocation.");
} catch {
  console.error(`Phase 2 production acceptance failed during ${stage}; credential values and raw errors were not displayed.`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  catch { console.error("Production browser cleanup failed."); process.exitCode = 1; }
  if (pool && temporarySessionId) {
    try { await pool.query("DELETE FROM sessions WHERE id=$1 AND user_id=$2", [temporarySessionId, fixtureOwners[0].id]); }
    catch { console.error("Temporary fixture-session cleanup failed; review the disposable branch."); process.exitCode = 1; }
  }
  try { await pool?.end(); }
  catch { console.error("Production fixture connection cleanup failed."); process.exitCode = 1; }
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }
  if (child && child.exitCode === null) {
    const stopped = new Promise<void>(resolve => child?.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([stopped, delay(2000)]);
    if (child.exitCode === null) { child.kill("SIGKILL"); await stopped; }
  }
  if (certificateDirectory) rmSync(certificateDirectory, { recursive: true, force: true });
}
