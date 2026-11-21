import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect, type Locator, type Page } from "@playwright/test";
import {
  INTERNAL_CLAIM_PATH,
  INTERNAL_INGEST_PATH,
  signInternalRequest,
} from "../../../shared/checks/signing.ts";
import { fixtureCookie, newFixtureSession, type FixtureDatabase } from "../auth/fixture-session.ts";

type Options = {
  origin: string;
  db: FixtureDatabase;
  reportDirectory: string;
  audit?(page: Page, paths: string[]): Promise<void>;
};

async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let index = 0; index < 180; index++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("A control could not be reached with Tab.");
}

async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

async function typeValue(page: Page, target: Locator, value: string) {
  await tabTo(page, target);
  await page.keyboard.press("Control+a");
  await page.keyboard.type(value);
}

async function toggle(page: Page, target: Locator, value: boolean) {
  await tabTo(page, target);
  if (await target.isChecked() !== value) await page.keyboard.press("Space");
  if (value) await expect(target).toBeChecked();
  else await expect(target).not.toBeChecked();
}

async function selectIndex(page: Page, target: Locator, index: number) {
  await tabTo(page, target);
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
}

async function refresh(page: Page) {
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function assertViewport(page: Page) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
}

function assertHeaders(headers: Record<string, string>) {
  const policy = headers["content-security-policy"] ?? "";
  assert(policy.includes("frame-ancestors 'none'"));
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.match(headers["strict-transport-security"] ?? "", /max-age=31536000/);
}

async function visit(page: Page, path: string) {
  const response = await page.goto(path);
  assert.equal(response?.status(), 200);
  const headers = response.headers();
  assertHeaders(headers);
  assert.match(headers["cache-control"], /no-store/);
  const nonce = /script-src[^;]*'nonce-([^']+)'/.exec(headers["content-security-policy"])?.[1];
  assert(nonce);
  const nonces = await page.locator("script:not([type]),script[type=module],script[type='text/javascript']")
    .evaluateAll((scripts) => scripts.map((script) => (script as HTMLScriptElement).nonce));
  assert(nonces.length > 0);
  assert(nonces.every((value) => value === nonce));
  await assertViewport(page);
}

/** Keyboard journeys use isolated synthetic accounts and the actual production routes. */
export async function verifyBrowser({ origin, db, reportDirectory, audit }: Options) {
  assert(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
  const [identity] = await db`SELECT current_user::text AS role,current_database()::text AS database`;
  assert.equal(identity.role, "monitrail_app.fixture");
  assert.equal(identity.database, "monitrail_phase10_fixture");
  await mkdir(reportDirectory, { recursive: true });

  const owner = randomUUID();
  const other = randomUUID();
  const foreignMonitor = randomUUID();
  const foreignPage = randomUUID();
  const session = newFixtureSession(owner);
  const secondSession = newFixtureSession(owner);
  const checks: string[] = [];
  const errors: string[] = [];
  const external: string[] = [];
  const screenshots: string[] = [];
  let stage = "seed isolated owners";
  let monitorId = "";
  let pageId = "";
  let telegramCode = "";
  let providerNavigation = 0;
  const executablePath = process.env.CHROME_PATH ??
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : chromium.executablePath());
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    await db.begin(async (sql) => {
      await sql`INSERT INTO users(id,name,email) VALUES
        (${owner},'QA private owner','qa-owner@example.invalid'),(${other},'QA foreign owner','qa-other@example.invalid')`;
      await sql`INSERT INTO sessions(session_token,user_id,expires) VALUES
        (${session.token},${owner},${session.expires}),(${secondSession.token},${owner},${secondSession.expires})`;
      await sql`INSERT INTO monitors(id,user_id,name,url,host,is_paused,pause_reason)
        VALUES (${foreignMonitor},${other},'QA foreign monitor','https://monitor.fixture.invalid/foreign','monitor.fixture.invalid',true,'user')`;
      await sql`INSERT INTO status_pages(id,user_id,slug,title) VALUES
        (${foreignPage},${other},'qa-foreign-page','QA foreign page')`;
      await sql`INSERT INTO status_page_monitors(status_page_id,user_id,monitor_id) VALUES
        (${foreignPage},${other},${foreignMonitor})`;
    });

    const ownerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 820 } });
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 360, height: 820 } });
    const noScript = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false, viewport: { width: 360, height: 820 } });
    for (const context of [ownerContext, anonymous, noScript]) {
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.protocol === "https:" && url.hostname === "github.com" && url.pathname === "/login/oauth/authorize") {
          providerNavigation++;
          return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html lang='en'><title>Fixture authorization</title><h1>Authorization fixture</h1></html>" });
        }
        external.push("unexpected external request");
        return route.abort();
      });
      context.on("page", (page) => {
        page.on("pageerror", () => errors.push("page error"));
        page.on("console", (message) => { if (message.type() === "error") errors.push("console error"); });
      });
    }
    for (const context of [ownerContext, anonymous, noScript]) {
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(15_000);
    }
    await ownerContext.addCookies([fixtureCookie(origin, session)]);
    const page = await ownerContext.newPage();
    const publicPage = await noScript.newPage();
    const visitor = await anonymous.newPage();
    const api = ownerContext.request;
    const ownerHeaders = { origin };
    const responseTo = (path: string, method: string) => page.waitForResponse((response) =>
      response.url() === origin + path && response.request().method() === method);
    const currentChannel = (label: string) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: label, exact: true }) });
    const currentPage = () => page.getByRole("region", { name: "QA public status", exact: true });

    async function publicHtml(slug: string, status = 200) {
      const response = await anonymous.request.get(`${origin}/status/${slug}`);
      assert.equal(response.status(), status);
      assertHeaders(response.headers());
      assert.match(response.headers()["cache-control"], /no-store/);
      const html = await response.text();
      for (const value of [owner, other, foreignMonitor, foreignPage, monitorId, pageId, session.token,
        secondSession.token, "qa-owner@example.invalid", "QA private owner", "QA foreign monitor",
        "fixture-private-query", "fixture-private-fragment", "recipient.fixture.invalid"]) {
        if (value) assert(!html.includes(value));
      }
      return html;
    }

    async function observe(statusCode: number) {
      await db`UPDATE monitors SET next_check_at=clock_timestamp()-interval '1 second' WHERE id=${monitorId}`;
      const secret = process.env.INTERNAL_HMAC_SECRET;
      assert(secret);
      const claimBody = JSON.stringify({ max: 15 });
      const claimed = await anonymous.request.post(origin + INTERNAL_CLAIM_PATH, {
        headers: Object.fromEntries(await signInternalRequest(secret, INTERNAL_CLAIM_PATH, claimBody)),
        data: claimBody,
      });
      assert.equal(claimed.status(), 200);
      const body = await claimed.json();
      assert.equal(body.jobs.length, 1);
      const job = body.jobs[0];
      assert.equal(job.monitor_id, monitorId);
      const resultBody = JSON.stringify({ results: [{
        attempt_id: job.attempt_id, monitor_id: monitorId, config_rev: job.config_rev,
        started_at: new Date().toISOString(), status_code: statusCode, response_ms: 120, redirect_count: 0,
      }] });
      const accepted = await anonymous.request.post(origin + INTERNAL_INGEST_PATH, {
        headers: Object.fromEntries(await signInternalRequest(secret, INTERNAL_INGEST_PATH, resultBody)),
        data: resultBody,
      });
      assert.equal(accepted.status(), 200);
      assert.equal((await accepted.json()).results[0].outcome, "accepted");
    }

    stage = "landing, login and bot keyboard routes";
    await visit(visitor, `${origin}/`);
    await activate(visitor, visitor.getByRole("link", { name: "Sign in", exact: true }));
    await expect(visitor.getByRole("button", { name: "Continue with GitHub", exact: true })).toBeVisible();
    await typeValue(visitor, visitor.getByLabel("Invitation code"), "synthetic-unused-invitation");
    await activate(visitor, visitor.getByRole("button", { name: "Continue with GitHub", exact: true }));
    await expect(visitor.getByRole("heading", { name: "Authorization fixture" })).toBeVisible();
    assert.equal(providerNavigation, 1);
    await visit(visitor, `${origin}/bot`);
    await expect(visitor.getByRole("heading", { name: "About the checker" })).toBeVisible();
    await tabTo(visitor, visitor.getByRole("link", { name: "abuse@example.invalid" }));
    checks.push("Landing and sign-in were keyboard operable, OAuth reached an intercepted authorization page, and the abuse contact was keyboard reachable.");

    stage = "create, verify, rename and delete a webhook channel";
    await visit(page, `${origin}/dashboard`);
    await expect(page.getByRole("heading", { name: "No monitors yet" })).toBeVisible();
    await activate(page, page.getByRole("link", { name: "Channels", exact: true }));
    await typeValue(page, page.getByLabel("Channel label", { exact: true }), "QA disposable webhook");
    await typeValue(page, page.getByLabel("Webhook URL"), "https://recipient.fixture.invalid/hook");
    let response = responseTo("/api/channels", "POST");
    await activate(page, page.getByRole("button", { name: "Add channel", exact: true }));
    assert.equal((await response).status(), 201);
    await expect(currentChannel("QA disposable webhook")).toBeVisible();
    const temporary = currentChannel("QA disposable webhook");
    await activate(page, temporary.getByRole("button", { name: "Send test alert" }));
    await expect(temporary.getByText("Verified", { exact: true })).toBeVisible();
    await activate(page, temporary.getByRole("button", { name: "Rename", exact: true }));
    await typeValue(page, temporary.getByLabel("Channel label"), "QA renamed webhook");
    await activate(page, temporary.getByRole("button", { name: "Save label" }));
    await expect(currentChannel("QA renamed webhook")).toBeVisible();
    await activate(page, currentChannel("QA renamed webhook").getByRole("button", { name: "Delete channel" }));
    let dialog = page.getByRole("dialog", { name: "Delete channel?" });
    await activate(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
    await expect(dialog).not.toBeVisible();
    await activate(page, currentChannel("QA renamed webhook").getByRole("button", { name: "Delete channel" }));
    await activate(page, dialog.getByRole("button", { name: "Delete channel", exact: true }));
    await expect(currentChannel("QA renamed webhook")).toHaveCount(0);

    async function addChannel(typeIndex: number, label: string, url: string) {
      await selectIndex(page, page.getByLabel("Channel type"), typeIndex);
      await typeValue(page, page.getByLabel("Channel label", { exact: true }), label);
      await typeValue(page, page.getByLabel("Webhook URL"), url);
      const added = responseTo("/api/channels", "POST");
      await activate(page, page.getByRole("button", { name: "Add channel", exact: true }));
      assert.equal((await added).status(), 201);
      const row = currentChannel(label);
      await expect(row).toBeVisible();
      await activate(page, row.getByRole("button", { name: "Send test alert" }));
      await expect(row.getByText("Verified", { exact: true })).toBeVisible();
    }
    await addChannel(0, "QA webhook", "https://recipient.fixture.invalid/hook");
    await addChannel(1, "QA Discord", "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ab");
    stage = "private Telegram link and test";
    await activate(page, page.getByRole("button", { name: "Create Telegram link" }));
    const telegram = page.getByRole("link", { name: "Open Telegram" });
    await expect(telegram).toBeVisible();
    const link = new URL((await telegram.getAttribute("href")) ?? "");
    assert.equal(link.pathname, "/monitrail_fixture_bot");
    telegramCode = link.searchParams.get("start") ?? "";
    assert(telegramCode);
    const telegramSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    assert(telegramSecret);
    const incoming = await anonymous.request.post(`${origin}/api/telegram/webhook`, {
      headers: { "x-telegram-bot-api-secret-token": telegramSecret },
      data: { update_id: 1, message: { text: `/start ${telegramCode}`, chat: { id: 123456789, type: "private" }, from: { id: 123456789, is_bot: false } } },
    });
    assert.equal(incoming.status(), 200);
    await activate(page, page.getByRole("button", { name: "Refresh channels" }));
    await expect(currentChannel("Telegram").getByText("Verified", { exact: true })).toBeVisible();
    await activate(page, currentChannel("Telegram").getByRole("button", { name: "Send test alert" }));
    await expect(currentChannel("Telegram").getByText("Test alert sent.")).toBeVisible();
    await activate(page, page.getByRole("button", { name: "Dismiss link" }));
    telegramCode = "";
    checks.push("Webhook and Discord creation and verification, webhook renaming and deletion, dialog cancellation, and private Telegram linking and testing used keyboard controls.");

    stage = "monitor creation and default subscriptions";
    await activate(page, page.getByRole("link", { name: "Dashboard", exact: true }));
    await activate(page, page.getByRole("link", { name: "Add monitor", exact: true }));
    await typeValue(page, page.getByLabel("Monitor name"), "QA checkout");
    await typeValue(page, page.getByLabel("URL", { exact: true }), "https://monitor.fixture.invalid/health?token=fixture-private-query#fixture-private-fragment");
    for (const checkbox of await page.getByRole("checkbox").all()) await expect(checkbox).toBeChecked();
    await activate(page, page.getByRole("button", { name: "Create monitor" }));
    await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]+$/);
    monitorId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
    assert(monitorId);
    await expect(page.getByText("Waiting for first check", { exact: false }).first()).toBeVisible();
    assert.equal((await db`SELECT count(*)::int AS count FROM monitor_alert_channels WHERE monitor_id=${monitorId}`)[0].count, 3);
    await observe(200);
    await db`UPDATE monitors SET created_at=clock_timestamp()-interval '2 days' WHERE id=${monitorId}`;
    await db`INSERT INTO checks(attempt_id,monitor_id,config_rev,checked_at,ok,status_code,response_ms)
      SELECT gen_random_uuid(),${monitorId},1,instant,true,200,120
      FROM generate_series(clock_timestamp()-interval '23 hours',clock_timestamp()-interval '1 minute',interval '5 minutes') AS instant`;
    await refresh(page);
    await expect(page.getByText("Up", { exact: true }).first()).toBeVisible();
    stage = "history ranges and keyboard chart";
    const chart = page.locator("svg[role='application']").first();
    await expect(chart).toBeVisible();
    await tabTo(page, chart);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await selectIndex(page, page.getByLabel("Day (UTC)"), 1);
    const ranges = page.getByRole("navigation", { name: "Check history range" });
    for (const label of ["7 d", "30 d", "24 h"]) {
      await activate(page, ranges.getByRole("link", { name: label, exact: true }));
      await expect(ranges.getByRole("link", { name: label, exact: true })).toHaveAttribute("aria-current", "page");
    }
    stage = "confirmed incident and recovery";
    await observe(503);
    await refresh(page);
    await expect(page.getByText("Confirming", { exact: true }).first()).toBeVisible();
    await observe(503);
    await refresh(page);
    await expect(page.getByText("Down", { exact: true }).first()).toBeVisible();
    await observe(200);
    await observe(200);
    await refresh(page);
    await expect(page.getByText("Up", { exact: true }).first()).toBeVisible();
    await expect.poll(async () => (await db`SELECT count(*)::int AS count FROM alert_outbox WHERE user_id=${owner} AND status='sent'`)[0].count).toBe(6);
    stage = "monitor edit, subscription edit, pause and resume";
    await typeValue(page, page.getByLabel("Monitor name"), "QA checkout updated");
    await activate(page, page.getByRole("button", { name: "Save changes", exact: true }));
    await expect(page.getByRole("heading", { name: "QA checkout updated", exact: true })).toBeVisible();
    const subscriptions = page.getByRole("region", { name: "Alert subscriptions" });
    const webhookSubscription = subscriptions.getByRole("checkbox", { name: /QA webhook/ });
    await toggle(page, webhookSubscription, false);
    await activate(page, subscriptions.getByRole("button", { name: "Save alert subscriptions" }));
    await expect(subscriptions.getByText("Alert subscriptions saved.")).toBeVisible();
    await activate(page, page.getByRole("button", { name: "Pause", exact: true }));
    await expect(page.getByText("Paused", { exact: true }).first()).toBeVisible();
    await activate(page, page.getByRole("button", { name: "Resume", exact: true }));
    await expect(page.getByText("Pending", { exact: true }).first()).toBeVisible();
    await typeValue(page, page.getByLabel("Replace URL"), "https://monitor.fixture.invalid/reconfigured?token=fixture-private-query#fixture-private-fragment");
    await activate(page, page.getByRole("button", { name: "Save changes", exact: true }));
    await expect(page.getByText("Changes saved.")).toBeVisible();
    await observe(200);
    await db`UPDATE monitors SET last_checked_at=clock_timestamp()-interval '901 seconds' WHERE id=${monitorId}`;
    await refresh(page);
    await expect(page.getByText("Unknown", { exact: true }).first()).toBeVisible();
    await activate(page, page.getByRole("link", { name: "View status", exact: true }));
    assert.equal(new URL(page.url()).hash, "#check-history");
    await observe(200);
    checks.push("Monitor creation, default and edited subscriptions, chart and history keyboard controls, confirmed outage and recovery, pause, resume, configuration edit and Unknown history link passed.");

    stage = "create a second monitor for status membership and deletion";
    await activate(page, page.getByRole("link", { name: "Dashboard", exact: true }).last());
    await activate(page, page.getByRole("link", { name: "Add monitor", exact: true }));
    await typeValue(page, page.getByLabel("Monitor name"), "QA docs");
    await typeValue(page, page.getByLabel("URL", { exact: true }), "https://monitor.fixture.invalid/docs");
    await activate(page, page.getByRole("button", { name: "Create monitor" }));
    await expect(page).toHaveURL(/\/monitors\/[0-9a-f-]+$/);
    const secondMonitor = new URL(page.url()).pathname.split("/").at(-1);
    assert(secondMonitor);
    await activate(page, page.getByRole("link", { name: "Status pages", exact: true }));
    const form = page.getByRole("region", { name: "New status page" });
    await typeValue(page, form.getByLabel("Page title"), "QA public status");
    await typeValue(page, form.getByLabel("Public slug"), "qa-public-status");
    await toggle(page, form.getByRole("checkbox", { name: "QA checkout updated", exact: true }), true);
    await toggle(page, form.getByRole("checkbox", { name: "QA docs", exact: true }), true);
    await toggle(page, form.getByRole("checkbox", { name: "Show URL for QA checkout updated", exact: true }), true);
    await activate(page, form.getByRole("button", { name: "Create draft" }));
    await expect(currentPage()).toBeVisible();
    pageId = (await db`SELECT id FROM status_pages WHERE user_id=${owner}`)[0].id;
    const draft = await publicHtml("qa-public-status", 404);
    const unknown = await publicHtml("qa-missing-status", 404);
    assert.equal(draft, unknown);
    await activate(page, currentPage().getByRole("button", { name: "Publish", exact: true }));
    await expect(currentPage().getByText("Published", { exact: true })).toBeVisible();
    assert((await publicHtml("qa-public-status")).includes("/reconfigured"));
    stage = "warm public history, hide URL, rename and unpublish";
    await toggle(page, currentPage().getByRole("checkbox", { name: "Show URL for QA checkout updated", exact: true }), false);
    response = responseTo(`/api/status-pages/${pageId}`, "PATCH");
    await activate(page, currentPage().getByRole("button", { name: "Save changes" }));
    assert.equal((await response).status(), 200);
    assert(!(await publicHtml("qa-public-status")).includes("monitor.fixture.invalid/reconfigured"));
    await typeValue(page, currentPage().getByLabel("Public slug"), "qa-renamed-status");
    response = responseTo(`/api/status-pages/${pageId}`, "PATCH");
    await activate(page, currentPage().getByRole("button", { name: "Save changes" }));
    assert.equal((await response).status(), 200);
    await publicHtml("qa-public-status", 404);
    await publicHtml("qa-renamed-status");
    await activate(page, currentPage().getByRole("button", { name: "Unpublish", exact: true }));
    await expect(currentPage().getByText("Draft", { exact: true })).toBeVisible();
    await publicHtml("qa-renamed-status", 404);
    await activate(page, currentPage().getByRole("button", { name: "Publish", exact: true }));
    await expect(currentPage().getByText("Published", { exact: true })).toBeVisible();
    await publicHtml("qa-renamed-status");
    stage = "public JavaScript-disabled status and viewport";
    await visit(publicPage, `${origin}/status/qa-renamed-status`);
    await activate(publicPage, publicPage.locator("details summary").first());
    await expect(publicPage.locator("details[open]").first()).toBeVisible();
    await publicPage.setViewportSize({ width: 1440, height: 920 });
    await assertViewport(publicPage);
    screenshots.push("public-status-desktop.png");
    await publicPage.screenshot({ path: join(reportDirectory, "public-status-desktop.png"), fullPage: true });
    await publicPage.setViewportSize({ width: 360, height: 820 });
    await assertViewport(publicPage);
    screenshots.push("public-status-mobile.png");
    await publicPage.screenshot({ path: join(reportDirectory, "public-status-mobile.png"), fullPage: true });
    stage = "remove a monitor from a primed public status page";
    await toggle(page, currentPage().getByRole("checkbox", { name: "QA docs", exact: true }), false);
    response = responseTo(`/api/status-pages/${pageId}`, "PATCH");
    await activate(page, currentPage().getByRole("button", { name: "Save changes" }));
    assert.equal((await response).status(), 200);
    assert(!(await publicHtml("qa-renamed-status")).includes("QA docs"));
    await toggle(page, currentPage().getByRole("checkbox", { name: "QA checkout updated", exact: true }), false);
    response = responseTo(`/api/status-pages/${pageId}`, "PATCH");
    await activate(page, currentPage().getByRole("button", { name: "Save changes" }));
    assert.equal((await response).status(), 200);
    await expect(currentPage().getByText("Draft", { exact: true })).toBeVisible();
    await publicHtml("qa-renamed-status", 404);
    await toggle(page, currentPage().getByRole("checkbox", { name: "QA checkout updated", exact: true }), true);
    response = responseTo(`/api/status-pages/${pageId}`, "PATCH");
    await activate(page, currentPage().getByRole("button", { name: "Save changes" }));
    assert.equal((await response).status(), 200);
    await publicHtml("qa-renamed-status", 404);
    await activate(page, currentPage().getByRole("button", { name: "Publish", exact: true }));
    await expect(currentPage().getByText("Published", { exact: true })).toBeVisible();
    await publicHtml("qa-renamed-status");
    await activate(page, currentPage().getByRole("button", { name: "Delete status page", exact: true }));
    dialog = page.getByRole("dialog", { name: "Delete status page?" });
    await activate(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
    stage = "delete a status page with keyboard confirmation";
    await typeValue(page, form.getByLabel("Page title"), "QA disposable status");
    await typeValue(page, form.getByLabel("Public slug"), "qa-disposable-status");
    await toggle(page, form.getByRole("checkbox", { name: "QA checkout updated", exact: true }), true);
    await activate(page, form.getByRole("button", { name: "Create draft" }));
    const disposablePage = page.getByRole("region", { name: "QA disposable status", exact: true });
    await expect(disposablePage).toBeVisible();
    await activate(page, disposablePage.getByRole("button", { name: "Delete status page", exact: true }));
    dialog = page.getByRole("dialog", { name: "Delete status page?" });
    await activate(page, dialog.getByRole("button", { name: "Delete status page", exact: true }));
    await expect(disposablePage).toHaveCount(0);
    checks.push("Public publishing, URL hiding, rename, unpublish, member removal, last-monitor draft and explicit republish reflected on the next request after prior public reads. Public HTML and JavaScript-disabled mobile/desktop history passed.");

    stage = "delete a monitor with keyboard confirmation";
    await visit(page, `${origin}/monitors/${secondMonitor}`);
    await activate(page, page.getByRole("button", { name: "Delete monitor", exact: true }));
    dialog = page.getByRole("dialog", { name: "Delete monitor?" });
    await activate(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
    await activate(page, page.getByRole("button", { name: "Delete monitor", exact: true }));
    await activate(page, dialog.getByRole("button", { name: "Delete monitor", exact: true }));
    await expect(page).toHaveURL(`${origin}/dashboard`);
    assert.equal((await db`SELECT count(*)::int AS count FROM monitors WHERE id=${secondMonitor}`)[0].count, 0);
    stage = "access boundaries";
    assert.equal((await api.patch(`${origin}/api/monitors/${foreignMonitor}`, { headers: ownerHeaders, data: { isPaused: false } })).status(), 404);
    assert.equal((await api.patch(`${origin}/api/status-pages/${foreignPage}`, { headers: ownerHeaders, data: { isPublished: true } })).status(), 404);
    assert.equal((await api.delete(`${origin}/api/account`, { headers: { origin: "https://foreign.example.invalid" }, data: { confirm: true } })).status(), 403);
    assert.equal((await api.delete(`${origin}/api/account`, { headers: ownerHeaders, data: { confirm: true, userId: other } })).status(), 400);
    checks.push("Monitor deletion and destructive-dialog cancellation passed. Foreign monitor/page writes, cross-origin deletion and owner-ID injection were refused.");

    stage = "desktop protected pages and accessibility audit";
    await page.setViewportSize({ width: 1440, height: 920 });
    for (const path of ["/dashboard", "/channels", "/status-pages", "/settings", `/monitors/${monitorId}`]) {
      await visit(page, origin + path);
    }
    if (audit) await audit(page, ["/", "/bot", "/dashboard", "/channels", "/status-pages", "/settings", `/monitors/${monitorId}`]);
    stage = "logout and session revocation";
    await visit(page, `${origin}/settings`);
    await activate(page, page.getByRole("button", { name: "Sign out", exact: true }));
    await expect(page).toHaveURL(`${origin}/`);
    assert.equal((await db`SELECT count(*)::int AS count FROM sessions WHERE session_token=${session.token}`)[0].count, 0);
    const protectedAfterLogout = await page.goto(`${origin}/settings`);
    assert.equal(protectedAfterLogout?.status(), 200);
    await expect(page).toHaveURL(/\/login\?next=/);
    await ownerContext.addCookies([fixtureCookie(origin, secondSession)]);
    await page.setViewportSize({ width: 360, height: 820 });
    await visit(page, `${origin}/settings`);
    stage = "account deletion through the production settings flow";
    await activate(page, page.getByRole("button", { name: "Delete account", exact: true }));
    dialog = page.getByRole("dialog", { name: "Delete account?" });
    await activate(page, dialog.getByRole("button", { name: "Cancel", exact: true }));
    await expect(dialog).not.toBeVisible();
    await publicHtml("qa-renamed-status");
    await activate(page, page.getByRole("button", { name: "Delete account", exact: true }));
    await assertViewport(page);
    screenshots.push("delete-account-mobile.png");
    await page.screenshot({ path: join(reportDirectory, "delete-account-mobile.png"), fullPage: true });
    await activate(page, dialog.getByRole("button", { name: "Delete account", exact: true }));
    await expect(page).toHaveURL(`${origin}/?account=deleted`);
    await expect(page.getByText("Your account and its data have been deleted.")).toBeVisible();
    await publicHtml("qa-renamed-status", 404);
    assert.equal((await db`SELECT count(*)::int AS count FROM sessions WHERE user_id=${owner}`)[0].count, 0);
    assert.equal((await db`SELECT count(*)::int AS count FROM users WHERE id=${owner}`)[0].count, 0);
    assert.equal((await db`SELECT count(*)::int AS count FROM users WHERE id=${other}`)[0].count, 1);
    await ownerContext.addCookies([fixtureCookie(origin, secondSession)]);
    await page.goto(`${origin}/dashboard`);
    await expect(page).toHaveURL(/\/login\?next=/);
    checks.push("Logout revoked the current session. Keyboard account deletion revoked all sessions, removed public visibility, preserved the other owner and showed the landing confirmation.");
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    const summary = {
      passed: true, checks, screenshots, consoleErrors: errors.length, unexpectedExternalRequests: external.length,
      omissions: [
        "Live OAuth consent and provider callback approval require the account owner.",
        "Telegram's remote Start action was represented by its authenticated incoming webhook.",
        "Slack uses the same guarded channel flow and is covered by adapter tests. This browser run exercised generic webhook, Discord and Telegram.",
      ],
    };
    await writeFile(join(reportDirectory, "browser.json"), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    return summary;
  } catch (error) {
    const location = error instanceof Error ? error.stack?.split("\n").find((line) => line.includes("/qa/browser.ts:"))?.trim() : undefined;
    await writeFile(join(reportDirectory, "browser.json"), `${JSON.stringify({ passed: false, stage, error: error instanceof Error ? error.name : "Unknown", location }, null, 2)}\n`, { mode: 0o600 });
    throw new Error(`Browser verification failed during ${stage}.`);
  } finally {
    telegramCode = "";
    await browser.close();
    await db`DELETE FROM users WHERE id IN (${owner},${other})`;
  }
}
