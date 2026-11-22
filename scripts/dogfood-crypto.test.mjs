import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decryptEvidence, encryptEvidence, validateEvidence, writePrivateOutput } from "./dogfood-crypto.mjs";
import { decryptDogfood } from "./decrypt-dogfood.mjs";

function evidenceFixture() {
  return {
    version: 1, from: "2026-11-01T00:00:00.000Z", to: "2026-11-02T00:00:00.000Z", capturedAt: "2026-11-02T00:00:00.001Z", missingAcceptanceEvidence: 0,
    monitors: [1, 2].map(value => ({ id: `a1000000-0000-4000-8000-00000000000${value}`, configRev: 1, intervalSeconds: 300, isPaused: false, createdAt: "2026-10-31T00:00:00.000Z" })),
    checks: [{ attemptId: "a2000000-0000-4000-8000-000000000001", monitorId: "a1000000-0000-4000-8000-000000000001", configRev: 1, checkedAt: "2026-11-01T12:00:00.000Z", acceptedAt: "2026-11-01T12:00:01.000Z", ok: true, statusCode: 200, responseMs: 15, errorType: null, redirectCount: 0 }],
    events: [1, 2].map(value => ({ id: `a3000000-0000-4000-8000-00000000000${value}`, monitorId: `a1000000-0000-4000-8000-00000000000${value}`, kind: "created", at: "2026-10-31T00:00:00.000Z" })),
    incidents: [],
  };
}

test("encrypts the allowlisted snapshot with fresh nonces and authenticated version/key metadata", () => {
  const key = randomBytes(32).toString("base64url");
  const snapshot = evidenceFixture();
  const first = encryptEvidence(snapshot, key), second = encryptEvidence(snapshot, key);
  assert.match(first, /^v1\.proof-1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.notEqual(first, second);
  assert(!first.includes(snapshot.monitors[0].id));
  assert(!first.includes("checkedAt"));
  assert.deepEqual(decryptEvidence(first, key), snapshot);
  assert.throws(() => decryptEvidence(first, randomBytes(32).toString("base64url")), /Private evidence could not be decrypted/);
  assert.throws(() => decryptEvidence(first, key, "different-key"));
  for (const tampered of [first.replace("v1.", "v2."), first.replace("proof-1", "proof-2"), first.slice(0, -3), `${first}=`, first.replace(/.$/, first.endsWith("A") ? "B" : "A")]) {
    assert.throws(() => decryptEvidence(tampered, key));
  }
  // Changing both the key ID and expected key ID cannot evade authenticated AAD.
  assert.throws(() => decryptEvidence(first.replace("proof-1", "proof-2"), key, "proof-2"));
});

test("rejects invalid key encodings and fields that could expose private application data", () => {
  const key = randomBytes(32).toString("base64url");
  for (const invalid of [undefined, "", `${key}=`, randomBytes(31).toString("base64url"), "private-credential"]) {
    assert.throws(() => encryptEvidence(evidenceFixture(), invalid));
  }
  for (const mutate of [
    value => { value.url = "https://private.example.invalid/?credential=secret"; },
    value => { value.monitors[0].name = "private name"; },
    value => { value.checks[0].headers = { authorization: "private" }; },
    value => { value.events[0].kind = "raw-exception"; },
    value => { value.checks[0].monitorId = "a1000000-0000-4000-8000-000000000003"; },
    value => { value.checks[0].acceptedAt = null; },
    value => { value.to = "2026-11-03T00:00:00.000Z"; },
    value => { value.monitors.pop(); },
  ]) {
    const snapshot = evidenceFixture();
    mutate(snapshot);
    assert.throws(() => validateEvidence(snapshot));
  }
  const missing = evidenceFixture();
  missing.checks[0].acceptedAt = null;
  missing.missingAcceptanceEvidence = 1;
  assert.deepEqual(validateEvidence(missing), missing);
});

test("writes only new 0600 files outside source and refuses overwrite and symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-private-capture-"));
  try {
    const output = join(directory, "evidence.enc");
    await writePrivateOutput(output, "encrypted-fixture", ".enc");
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(writePrivateOutput(output, "replacement", ".enc"));
    const link = join(directory, "linked.enc");
    await symlink(output, link);
    await assert.rejects(writePrivateOutput(link, "replacement", ".enc"));
    assert.equal(await readFile(output, "utf8"), "encrypted-fixture");
    await assert.rejects(writePrivateOutput(new URL("./evidence.enc", import.meta.url).pathname, "fixture", ".enc"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("decrypts locally to a private JSON file and refuses wrong keys, overwrite and symlink inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-proof-decryption-"));
  try {
    const env = { DOGFOOD_PROOF_KEY: randomBytes(32).toString("base64url") };
    const input = join(directory, "evidence.enc"), output = join(directory, "evidence.json");
    await writePrivateOutput(input, encryptEvidence(evidenceFixture(), env.DOGFOOD_PROOF_KEY), ".enc");
    await decryptDogfood(env, input, output);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidenceFixture());
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(decryptDogfood(env, input, output), /Dogfood decryption failed/);
    const refused = join(directory, "refused.json");
    await assert.rejects(decryptDogfood({ DOGFOOD_PROOF_KEY: randomBytes(32).toString("base64url") }, input, refused), /Dogfood decryption failed/);
    await assert.rejects(readFile(refused));
    const link = join(directory, "linked.enc");
    await symlink(input, link);
    await assert.rejects(decryptDogfood(env, link, refused));
    await assert.rejects(readFile(refused));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
