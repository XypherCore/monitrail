import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decryptEvidence, encryptEvidence, validateEvidence, writePrivateOutput } from "./dogfood-crypto.mjs";
import { decryptDogfood } from "./decrypt-dogfood.mjs";
import * as decryption from "./decrypt-dogfood.mjs";

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

test("production-key mode selects only the canonical local proof settings without changing the environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-production-proof-"));
  const previousEnvironment = process.env;
  const isolatedEnvironment = { MONITRAIL_DECRYPT_SENTINEL: "synthetic-unchanged" };
  process.env = isolatedEnvironment;
  try {
    const key = randomBytes(32).toString("base64url"), keyId = "fixture-proof";
    const input = join(directory, "evidence.enc"), output = join(directory, "evidence.json");
    await writePrivateOutput(input, encryptEvidence(evidenceFixture(), key, keyId), ".enc");
    const privateFile = join(directory, "fixture.local");
    await writeFile(privateFile, `DOGFOOD_PROOF_KEY='${key}'\nDOGFOOD_PROOF_KEY_ID='${keyId}'\nDATABASE_URL='private-runtime-fixture'\nMIGRATION_DATABASE_URL='private-admin-fixture'\nTELEGRAM_BOT_TOKEN='private-bot-fixture'\n`, { mode: 0o400 });
    let readCount = 0, decryptCount = 0;
    await decryption.runDecryptDogfood(["--input", input, "--output", output, "--production-key"], {
      DOGFOOD_PROOF_KEY: "private-ambient-key-must-not-be-used", DOGFOOD_PROOF_KEY_ID: "ambient-proof",
    }, {
      async readConfiguration(file) {
        readCount++;
        assert.equal(file.href, new URL("../web/.env.production.local", import.meta.url).href);
        return decryption.readPrivateProofConfiguration(pathToFileURL(privateFile));
      },
      async decrypt(env, actualInput, actualOutput) {
        decryptCount++;
        assert.deepEqual(env, { DOGFOOD_PROOF_KEY: key, DOGFOOD_PROOF_KEY_ID: keyId });
        await decryptDogfood(env, actualInput, actualOutput);
      },
    });
    assert.equal(readCount, 1);
    assert.equal(decryptCount, 1);
    assert.equal(process.env, isolatedEnvironment);
    assert.deepEqual(isolatedEnvironment, { MONITRAIL_DECRYPT_SENTINEL: "synthetic-unchanged" });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidenceFixture());
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    assert.equal((await stat(privateFile)).mode & 0o777, 0o400);
  } finally {
    process.env = previousEnvironment;
    await rm(directory, { recursive: true, force: true });
  }
});

test("production-key mode uses the default proof ID and never falls back to ambient keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-default-production-proof-"));
  try {
    const key = randomBytes(32).toString("base64url");
    const input = join(directory, "evidence.enc"), output = join(directory, "evidence.json");
    await writePrivateOutput(input, encryptEvidence(evidenceFixture(), key), ".enc");
    const ambient = { DOGFOOD_PROOF_KEY: key, DOGFOOD_PROOF_KEY_ID: "wrong-ambient-id" };
    const args = ["--input", input, "--output", output, "--production-key"];
    for (const content of ["DATABASE_URL='private-runtime-fixture'\n", "DOGFOOD_PROOF_KEY='private-invalid-key'\n"]) {
      await assert.rejects(decryption.runDecryptDogfood(args, ambient, { readConfiguration: async () => ({ content }) }), /^Error: Dogfood decryption failed\.$/);
      await assert.rejects(readFile(output));
    }
    await decryption.runDecryptDogfood(args, ambient, { readConfiguration: async () => ({ content: `DOGFOOD_PROOF_KEY='${key}'\n` }) });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidenceFixture());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("production-key selection ignores comments and proof-looking text inside unrelated multiline settings", async () => {
  const key = randomBytes(32).toString("base64url"), keyId = "fixture-proof";
  const args = ["--input", join(tmpdir(), "fixture.enc"), "--output", join(tmpdir(), "fixture.json"), "--production-key"];
  for (const delimiter of ["'", '"', "`"]) {
    const content = `# DOGFOOD_PROOF_KEY='comment-key' and an unmatched \"\nDATABASE_URL=${delimiter}private-runtime-fixture\nDOGFOOD_PROOF_KEY=multiline-decoy\nDOGFOOD_PROOF_KEY_ID=multiline-decoy\n${delimiter} # trailing comment with an unmatched '\nDOGFOOD_PROOF_KEY='${key}'\nDOGFOOD_PROOF_KEY_ID='${keyId}'\n`;
    let decrypted = false;
    await decryption.runDecryptDogfood(args, {}, {
      readConfiguration: async () => ({ content }),
      async decrypt(env) {
        decrypted = true;
        assert.deepEqual(env, { DOGFOOD_PROOF_KEY: key, DOGFOOD_PROOF_KEY_ID: keyId });
      },
    });
    assert.equal(decrypted, true);
  }
});

test("production-key selection rejects duplicate or ambiguous settings before decryption", async () => {
  const key = randomBytes(32).toString("base64url");
  const args = ["--input", join(tmpdir(), "fixture.enc"), "--output", join(tmpdir(), "fixture.json"), "--production-key"];
  const keyLine = `DOGFOOD_PROOF_KEY='${key}'\n`;
  const invalid = [
    `${keyLine}${keyLine}`,
    `${keyLine}DOGFOOD_PROOF_KEY='${randomBytes(32).toString("base64url")}'\n`,
    `${keyLine}DOGFOOD_PROOF_KEY_ID='proof-1'\nDOGFOOD_PROOF_KEY_ID='proof-1'\n`,
    `${keyLine}DOGFOOD_PROOF_KEY_ID='proof-1'\nDOGFOOD_PROOF_KEY_ID='proof-2'\n`,
    `${keyLine}export DOGFOOD_PROOF_KEY='${key}'\n`,
    `${keyLine}'DOGFOOD_PROOF_KEY'='${key}'\n`,
    `${keyLine} DOGFOOD_PROOF_KEY='${key}'\n`,
    `${keyLine}DATABASE_URL='private-unterminated\n`,
    `DATABASE_URL='private-unterminated\nDOGFOOD_PROOF_KEY=${key}\n`,
    `${keyLine}DATABASE_URL='private-fixture' unexpected\n`,
    `${keyLine}DOGFOOD_PROOF_KEY_ID='invalid id'\n`,
  ];
  for (const content of invalid) {
    let decrypted = false;
    await assert.rejects(decryption.runDecryptDogfood(args, {}, {
      readConfiguration: async () => ({ content }),
      async decrypt() { decrypted = true; },
    }), /^Error: Dogfood decryption failed\.$/);
    assert.equal(decrypted, false);
  }
});

test("production settings read failures remain generic and create no evidence output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-unavailable-production-proof-"));
  try {
    const output = join(directory, "evidence.json");
    await assert.rejects(decryption.runDecryptDogfood(["--input", join(directory, "evidence.enc"), "--output", output, "--production-key"], {}, {
      async readConfiguration() { throw new Error("private-file-token-detail"); },
    }), /^Error: Dogfood decryption failed\.$/);
    await assert.rejects(readFile(output));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the proof settings reader is bounded, owner-only, regular-file-only, and never changes permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-private-proof-reader-"));
  const file = join(directory, "fixture.local");
  const originalGetuid = process.getuid;
  try {
    await writeFile(file, "DOGFOOD_PROOF_KEY='synthetic'\n", { mode: 0o400 });
    assert.deepEqual(await decryption.readPrivateProofConfiguration(pathToFileURL(file)), { content: "DOGFOOD_PROOF_KEY='synthetic'\n" });
    assert.equal((await stat(file)).mode & 0o777, 0o400);
    const link = join(directory, "linked.local");
    await symlink(file, link);
    await assert.rejects(decryption.readPrivateProofConfiguration(pathToFileURL(link)));
    await assert.rejects(decryption.readPrivateProofConfiguration(pathToFileURL(directory)));
    await chmod(file, 0o644);
    await assert.rejects(decryption.readPrivateProofConfiguration(pathToFileURL(file)));
    assert.equal((await stat(file)).mode & 0o777, 0o644);
    await chmod(file, 0o600);
    if (originalGetuid) {
      process.getuid = () => originalGetuid() + 1;
      await assert.rejects(decryption.readPrivateProofConfiguration(pathToFileURL(file)));
      process.getuid = originalGetuid;
    }
    await writeFile(file, Buffer.alloc(262_145));
    await assert.rejects(decryption.readPrivateProofConfiguration(pathToFileURL(file)));
  } finally {
    process.getuid = originalGetuid;
    await rm(directory, { recursive: true, force: true });
  }
});

test("decrypt command arguments reject unknown, duplicate and missing fields before any private read", async () => {
  const input = join(tmpdir(), "fixture.enc"), output = join(tmpdir(), "fixture.json");
  assert.deepEqual(decryption.parseDecryptArguments(["--input", input, "--output", output]), { input, output, productionKey: false });
  assert.deepEqual(decryption.parseDecryptArguments(["--input", input, "--output", output, "--production-key"]), { input, output, productionKey: true });
  const invalid = [[], ["--input", input], ["--input", input, "--output"],
    ["--input", input, "--output", output, "--unknown"],
    ["--input", input, "--output", output, "--production-key", "--production-key"],
    ["--input", input, "--output", output, "--env-file", "/private/alternative.local"],
    ["--input", input, "--input", input], ["--output", output, "--input", input],
    ["--input", "relative.enc", "--output", output, "--production-key"],
    ["--input", input, "--output", "relative.json", "--production-key"],
    ["--input", input, "--output", output, "--production-key=/private/alternative.local"]];
  for (const args of invalid) {
    let accessed = false;
    await assert.rejects(decryption.runDecryptDogfood(args, {}, {
      async readConfiguration() { accessed = true; throw new Error("private-reader-must-not-run"); },
      async decrypt() { accessed = true; throw new Error("private-decrypt-must-not-run"); },
    }), /^Error: Dogfood decryption failed\.$/);
    assert.equal(accessed, false);
  }
});

test("legacy environment-only invocation still works without reading production settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "monitrail-environment-proof-"));
  try {
    const env = { DOGFOOD_PROOF_KEY: randomBytes(32).toString("base64url") };
    const input = join(directory, "evidence.enc"), output = join(directory, "imported.json");
    await writePrivateOutput(input, encryptEvidence(evidenceFixture(), env.DOGFOOD_PROOF_KEY), ".enc");
    await decryption.runDecryptDogfood(["--input", input, "--output", output], env, {
      async readConfiguration() { throw new Error("Production settings must not be read."); },
    });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), evidenceFixture());
    const cliOutput = join(directory, "command.json");
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./decrypt-dogfood.mjs", import.meta.url)), "--input", input, "--output", cliOutput], {
      encoding: "utf8", env: { PATH: process.env.PATH, DOGFOOD_PROOF_KEY: env.DOGFOOD_PROOF_KEY }, timeout: 10_000,
    });
    assert.equal(cli.error, undefined);
    assert.equal(cli.status, 0);
    assert.equal(cli.stdout, "Dogfood evidence decrypted to a new private file.\n");
    assert.equal(cli.stderr, "");
    assert.deepEqual(JSON.parse(await readFile(cliOutput, "utf8")), evidenceFixture());
  } finally { await rm(directory, { recursive: true, force: true }); }
});
