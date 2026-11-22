import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { captureDogfood } from "./capture-dogfood.mjs";
import { decryptEvidence, MAX_EVIDENCE_BYTES } from "./dogfood-crypto.mjs";

const snapshot = () => ({ version: 1, from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", capturedAt: "2026-11-02T00:00:00.001Z", missingAcceptanceEvidence: 0,
  monitors: [1, 2].map(value => ({ id: `a1000000-0000-4000-8000-00000000000${value}`, configRev: 1, intervalSeconds: 300, isPaused: false, createdAt: "2026-10-31T00:00:00.000Z" })), checks: [], events: [], incidents: [] });
const config = () => ({ APP_URL: "https://app.example.invalid", DOGFOOD_EXPORT_HMAC_SECRET: randomBytes(36).toString("base64url"), DOGFOOD_PROOF_KEY: randomBytes(32).toString("base64url") });

test("signs only the fixed empty-body proof request and writes encrypted evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-capture-"));
  try {
    const env = config(), requests = [];
    const transport = async (url, init) => {
      requests.push({ url: String(url), init });
      assert.equal(String(url), `${env.APP_URL}/api/internal/dogfood-evidence`);
      assert.equal(init.method, "POST");
      assert.equal(init.body, "{}");
      assert.equal(init.redirect, "manual");
      assert.equal(init.credentials, "omit");
      const headers = new Headers(init.headers);
      const timestamp = headers.get("x-monitrail-ts"), nonce = headers.get("x-monitrail-nonce");
      const hash = createHash("sha256").update("{}").digest("hex");
      const canonical = `v1\nPOST\n/api/internal/dogfood-evidence\n${timestamp}\n${nonce}\n${hash}`;
      assert.equal(headers.get("x-monitrail-sig"), createHmac("sha256", env.DOGFOOD_EXPORT_HMAC_SECRET).update(canonical).digest("hex"));
      assert(!JSON.stringify(Object.fromEntries(headers)).includes(env.DOGFOOD_EXPORT_HMAC_SECRET));
      return Response.json(snapshot(), { headers: { "cache-control": "no-store" } });
    };
    const output = join(directory, "dogfood-evidence.enc");
    await captureDogfood(env, output, transport);
    const encrypted = await readFile(output, "utf8");
    assert(!encrypted.includes("monitorId"));
    assert.deepEqual(decryptEvidence(encrypted, env.DOGFOOD_PROOF_KEY), snapshot());
    await captureDogfood(env, join(directory, "second.enc"), transport);
    assert.notEqual(new Headers(requests[0].init.headers).get("x-monitrail-nonce"), new Headers(requests[1].init.headers).get("x-monitrail-nonce"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects ambiguous origins, missing keys and invalid output paths before sending a signature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-capture-invalid-"));
  try {
    let calls = 0;
    const transport = async () => { calls++; return Response.json(snapshot()); };
    for (const url of ["http://app.example.invalid", "https://user:credential@app.example.invalid", "https://app.example.invalid/private", "https://app.example.invalid/?secret=value", "https://app.example.invalid/#secret", "https://app.example.invalid/./"]) {
      await assert.rejects(captureDogfood({ ...config(), APP_URL: url }, join(directory, "evidence.enc"), transport));
    }
    await assert.rejects(captureDogfood({ ...config(), DOGFOOD_PROOF_KEY: "invalid" }, join(directory, "evidence.enc"), transport));
    await assert.rejects(captureDogfood({ ...config(), DOGFOOD_EXPORT_HMAC_SECRET: "invalid" }, join(directory, "evidence.enc"), transport));
    await assert.rejects(captureDogfood(config(), "relative.enc", transport));
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("refuses redirects, provider errors, oversized bodies and private fields without retaining plaintext", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-capture-refused-"));
  try {
    const env = config();
    const output = join(directory, "evidence.enc");
    let cancelled = 0;
    for (const response of [
      new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 }),
      Response.redirect("https://untrusted.example.invalid/private", 302),
      new Response("private-response", { headers: { "content-type": "text/plain" } }),
      Response.json({ ...snapshot(), url: "https://private.example.invalid/?secret=value" }),
      new Response(new Uint8Array(MAX_EVIDENCE_BYTES + 1), { headers: { "content-type": "application/json" } }),
    ]) {
      await assert.rejects(captureDogfood(env, output, async () => response), error => {
        assert.equal(error.message, "Dogfood capture failed.");
        return true;
      });
      await assert.rejects(readFile(output));
    }
    assert.equal(cancelled, 1);
    await assert.rejects(captureDogfood(env, output, async () => { throw new Error(env.DOGFOOD_EXPORT_HMAC_SECRET); }), /Dogfood capture failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("capture and decryption commands fail generically and never print credentials", () => {
  const secret = randomBytes(36).toString("base64url");
  for (const file of ["capture-dogfood.mjs", "decrypt-dogfood.mjs"]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], {
      encoding: "utf8", env: { PATH: process.env.PATH, APP_URL: "https://private:credential@app.example.invalid", DOGFOOD_EXPORT_HMAC_SECRET: secret, DOGFOOD_PROOF_KEY: secret },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert(!result.stderr.includes(secret));
    assert(!result.stderr.includes("private:credential"));
    assert.match(result.stderr, /failed/);
  }
});

test("does not wait for an uncooperative response cancellation after exceeding the body bound", { timeout: 1000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-capture-cancellation-"));
  try {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(MAX_EVIDENCE_BYTES + 1)); },
      cancel() { return new Promise(() => {}); },
    });
    await assert.rejects(captureDogfood(config(), join(directory, "evidence.enc"), async () =>
      new Response(body, { headers: { "content-type": "application/json", "cache-control": "no-store" } })), /Dogfood capture failed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
