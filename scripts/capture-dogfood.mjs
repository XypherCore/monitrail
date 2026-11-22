import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INTERNAL_DOGFOOD_EVIDENCE_PATH, isInternalSecret, signInternalRequest } from "../shared/checks/signing.ts";
import { awaitSignal, cancelBody } from "../shared/ssrf/io.ts";
import { encryptEvidence, MAX_EVIDENCE_BYTES, newPrivateOutputPath, proofKey, proofKeyId, validateEvidence, writePrivateOutput } from "./dogfood-crypto.mjs";

async function boundedJson(response, signal) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_EVIDENCE_BYTES)) throw new Error();
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const pieces = [];
  let size = 0, data;
  try {
    while (true) {
      const { value, done } = await awaitSignal(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_EVIDENCE_BYTES) throw new Error();
      pieces.push(Buffer.from(value));
    }
    data = Buffer.concat(pieces);
    return JSON.parse(data.toString("utf8"));
  } finally {
    if (size > MAX_EVIDENCE_BYTES || signal.aborted) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Cleanup must not extend the request deadline. */ }
    data?.fill(0);
    for (const piece of pieces) piece.fill(0);
  }
}

/** Only the operator-configured application origin receives the dedicated proof signature. */
export async function captureDogfood(env, output, transport = fetch) {
  let response;
  try {
    if (typeof env.APP_URL !== "string") throw new Error();
    const origin = new URL(env.APP_URL);
    if (origin.protocol !== "https:" || origin.username || origin.password || (env.APP_URL !== origin.origin && env.APP_URL !== `${origin.origin}/`)) throw new Error();
    if (!isInternalSecret(env.DOGFOOD_EXPORT_HMAC_SECRET)) throw new Error();
    proofKey(env.DOGFOOD_PROOF_KEY).fill(0);
    const keyId = proofKeyId(env.DOGFOOD_PROOF_KEY_ID);
    await newPrivateOutputPath(output, ".enc");
    const body = "{}";
    const headers = await signInternalRequest(env.DOGFOOD_EXPORT_HMAC_SECRET, INTERNAL_DOGFOOD_EVIDENCE_PATH, body);
    const signal = AbortSignal.timeout(30_000);
    response = await awaitSignal(transport(new URL(INTERNAL_DOGFOOD_EVIDENCE_PATH, origin.origin), {
      method: "POST", body, headers, redirect: "manual", credentials: "omit", cache: "no-store", signal,
    }), signal);
    if (response.status !== 200 || response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")) throw new Error();
    const snapshot = validateEvidence(await boundedJson(response, signal));
    const encrypted = encryptEvidence(snapshot, env.DOGFOOD_PROOF_KEY, keyId);
    await writePrivateOutput(output, encrypted, ".enc");
  } catch { throw new Error("Dogfood capture failed."); }
  finally { if (response) cancelBody(response); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error();
    await captureDogfood(process.env, process.argv[3]);
    console.log("Encrypted dogfood evidence captured.");
  } catch {
    console.error("::error::Dogfood capture failed. Check configuration and the new private output path.");
    process.exitCode = 1;
  }
}
