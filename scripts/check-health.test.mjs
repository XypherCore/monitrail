import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkHealth } from "./check-health.mjs";

test("checks only the configured HTTPS application's health path", async () => {
  const calls = [];
  assert.equal(await checkHealth("https://app.example.invalid/", async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 200 });
  }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://app.example.invalid/api/health");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.credentials, "omit");
  assert.equal(calls[0].init.cache, "no-store");
  assert(calls[0].init.signal instanceof AbortSignal);
});

test("rejects missing or ambiguous application origins before issuing a request", async () => {
  let requests = 0;
  const transport = async () => { requests++; return new Response(); };
  for (const url of [
    undefined, "", "http://app.example.invalid", "https://user:password@app.example.invalid",
    "https://app.example.invalid/private", "https://app.example.invalid/?query=private",
    "https://app.example.invalid/#private", "https://app.example.invalid/./", "not-a-url",
  ]) {
    assert.equal(await checkHealth(url, transport), false);
  }
  assert.equal(requests, 0);
});

test("fails on unhealthy responses, redirects and network errors", async () => {
  for (const response of [
    new Response("private-fixture-body", { status: 503 }),
    Response.redirect("https://untrusted.example.invalid", 302),
    new Response(null, { status: 204 }),
  ]) {
    assert.equal(await checkHealth("https://app.example.invalid", async () => response), false);
  }
  assert.equal(await checkHealth("https://app.example.invalid", async () => {
    throw new Error("private-fixture-error");
  }), false);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await checkHealth("https://app.example.invalid", async () => {
    throw controller.signal.reason;
  }), false);
});

test("discards response content after the status check", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  assert.equal(await checkHealth("https://app.example.invalid", async () =>
    new Response(body, { status: 200 })), true);
  assert.equal(cancelled, true);
});

test("the command fails loudly with a generic message for invalid configuration", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./check-health.mjs", import.meta.url))], {
    env: { PATH: process.env.PATH, APP_URL: "https://private:credential@app.example.invalid" },
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), "::error::Application health check failed.");
});
