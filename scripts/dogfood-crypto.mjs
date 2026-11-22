import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isInternalUuid } from "../shared/checks/signing.ts";

export const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = Math.ceil((MAX_EVIDENCE_BYTES + 16) * 4 / 3) + 256;
const checkout = fileURLToPath(new URL("../", import.meta.url));
const DAY = 86_400_000;
const errors = ["dns", "timeout", "tls", "connect", "bad_status", "blocked", "other"];
const eventKinds = ["created", "paused", "resumed", "config_changed", "blocked"];
const resolutions = ["recovered", "paused", "config_changed", "blocked"];

function invalid() { throw new Error("Dogfood evidence is invalid."); }
function object(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}
function list(value, limit = 50_000) { if (!Array.isArray(value) || value.length > limit) invalid(); return value; }
function integer(value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function boolean(value) { if (typeof value !== "boolean") invalid(); return value; }
function uuid(value) { if (!isInternalUuid(value)) invalid(); return value; }
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) invalid();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalid();
  const result = parsed.toISOString();
  if (result !== value && result.replace(".000Z", "Z") !== value) invalid();
  return result;
}
function optionalTimestamp(value) { return value === null ? null : timestamp(value); }
function member(value, allowed) { if (!allowed.includes(value)) invalid(); return value; }
function unique(rows, key) { if (new Set(rows.map(row => row[key])).size !== rows.length) invalid(); return rows; }

/** Reconstruct the fixed projection before encryption. Unknown/private fields fail closed. */
export function validateEvidence(value) {
  const data = object(value, ["version", "from", "to", "capturedAt", "missingAcceptanceEvidence", "monitors", "checks", "events", "incidents"]);
  if (data.version !== 1) invalid();
  const from = timestamp(data.from), to = timestamp(data.to), capturedAt = timestamp(data.capturedAt);
  if (Date.parse(to) - Date.parse(from) !== DAY || Date.parse(to) > Date.parse(capturedAt)) invalid();
  const monitors = unique(list(data.monitors, 2).map(value => {
    const row = object(value, ["id", "configRev", "intervalSeconds", "isPaused", "createdAt"]);
    const createdAt = timestamp(row.createdAt);
    if (Date.parse(createdAt) > Date.parse(capturedAt)) invalid();
    return { id: uuid(row.id), configRev: integer(row.configRev, 1), intervalSeconds: member(row.intervalSeconds, [300, 600, 900, 1800, 3600]), isPaused: boolean(row.isPaused), createdAt };
  }), "id");
  if (monitors.length !== 2) invalid();
  const selected = new Set(monitors.map(row => row.id));
  const monitorId = value => { const id = uuid(value); if (!selected.has(id)) invalid(); return id; };
  const inWindow = value => Date.parse(value) >= Date.parse(from) && Date.parse(value) < Date.parse(to);
  const checks = unique(list(data.checks).map(value => {
    const row = object(value, ["attemptId", "monitorId", "configRev", "checkedAt", "acceptedAt", "ok", "statusCode", "responseMs", "errorType", "redirectCount"]);
    const checkedAt = timestamp(row.checkedAt), acceptedAt = optionalTimestamp(row.acceptedAt);
    if (Date.parse(checkedAt) > Date.parse(capturedAt) || (acceptedAt !== null && (Date.parse(acceptedAt) < Date.parse(checkedAt) || Date.parse(acceptedAt) > Date.parse(capturedAt))) || (!inWindow(checkedAt) && !(acceptedAt !== null && inWindow(acceptedAt)))) invalid();
    return { attemptId: uuid(row.attemptId), monitorId: monitorId(row.monitorId), configRev: integer(row.configRev, 1), checkedAt, acceptedAt,
      ok: boolean(row.ok), statusCode: row.statusCode === null ? null : integer(row.statusCode, 100, 599), responseMs: row.responseMs === null ? null : integer(row.responseMs),
      errorType: row.errorType === null ? null : member(row.errorType, errors), redirectCount: integer(row.redirectCount, 0, 2) };
  }), "attemptId");
  const missingAcceptanceEvidence = integer(data.missingAcceptanceEvidence);
  if (missingAcceptanceEvidence !== checks.filter(row => row.acceptedAt === null).length) invalid();
  const events = unique(list(data.events).map(value => {
    const row = object(value, ["id", "monitorId", "kind", "at"]);
    const at = timestamp(row.at), kind = member(row.kind, eventKinds);
    if (Date.parse(at) >= Date.parse(to) || (kind === "config_changed" && !inWindow(at))) invalid();
    return { id: uuid(row.id), monitorId: monitorId(row.monitorId), kind, at };
  }), "id");
  const incidents = unique(list(data.incidents).map(value => {
    const row = object(value, ["id", "monitorId", "startedAt", "confirmedAt", "resolvedAt", "resolvedConfirmedAt", "resolvedReason", "cause"]);
    const startedAt = timestamp(row.startedAt), confirmedAt = timestamp(row.confirmedAt), resolvedAt = optionalTimestamp(row.resolvedAt), resolvedConfirmedAt = optionalTimestamp(row.resolvedConfirmedAt);
    const resolvedReason = row.resolvedReason === null ? null : member(row.resolvedReason, resolutions);
    if (Date.parse(startedAt) > Date.parse(confirmedAt) || Date.parse(confirmedAt) > Date.parse(capturedAt) || Date.parse(startedAt) >= Date.parse(to) ||
      (resolvedAt !== null && (Date.parse(resolvedAt) < Date.parse(startedAt) || Date.parse(resolvedAt) < Date.parse(from) || Date.parse(resolvedAt) > Date.parse(capturedAt))) ||
      (resolvedConfirmedAt !== null && (resolvedAt === null || Date.parse(resolvedConfirmedAt) < Date.parse(resolvedAt) || Date.parse(resolvedConfirmedAt) > Date.parse(capturedAt))) ||
      (resolvedAt === null) !== (resolvedReason === null) || (resolvedReason === "recovered" && resolvedConfirmedAt === null)) invalid();
    return { id: uuid(row.id), monitorId: monitorId(row.monitorId), startedAt, confirmedAt, resolvedAt, resolvedConfirmedAt, resolvedReason, cause: member(row.cause, errors) };
  }), "id");
  if (checks.length + events.length + incidents.length > 50_000) invalid();
  return { version: 1, from, to, capturedAt, missingAcceptanceEvidence, monitors, checks, events, incidents };
}

export function proofKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Proof key is invalid.");
  const key = Buffer.from(value, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== value) throw new Error("Proof key is invalid.");
  return key;
}
export function proofKeyId(value = "proof-1") {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) throw new Error("Proof key ID is invalid.");
  return value;
}
const aad = keyId => Buffer.from(`dogfood-evidence\nv1\n${keyId}`, "utf8");

export function encryptEvidence(value, encodedKey, keyId = "proof-1") {
  let key, plaintext;
  try {
    key = proofKey(encodedKey);
    const id = proofKeyId(keyId);
    plaintext = Buffer.from(JSON.stringify(validateEvidence(value)), "utf8");
    if (plaintext.length > MAX_EVIDENCE_BYTES) throw new Error();
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(aad(id));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return `v1.${id}.${nonce.toString("base64url")}.${encrypted.toString("base64url")}`;
  } catch { throw new Error("Private evidence could not be encrypted."); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

export function decryptEvidence(envelope, encodedKey, keyId = "proof-1") {
  let key, plaintext;
  try {
    key = proofKey(encodedKey);
    const id = proofKeyId(keyId);
    if (typeof envelope !== "string" || Buffer.byteLength(envelope) > MAX_ENVELOPE_BYTES) throw new Error();
    const pieces = envelope.split(".");
    if (pieces.length !== 4 || pieces[0] !== "v1" || pieces[1] !== id || !/^[A-Za-z0-9_-]{16}$/.test(pieces[2]) || !/^[A-Za-z0-9_-]+$/.test(pieces[3])) throw new Error();
    const nonce = Buffer.from(pieces[2], "base64url"), sealed = Buffer.from(pieces[3], "base64url");
    if (nonce.length !== 12 || nonce.toString("base64url") !== pieces[2] || sealed.length <= 16 || sealed.length > MAX_EVIDENCE_BYTES + 16 || sealed.toString("base64url") !== pieces[3]) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    decipher.setAAD(aad(id));
    decipher.setAuthTag(sealed.subarray(-16));
    plaintext = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
    return validateEvidence(JSON.parse(plaintext.toString("utf8")));
  } catch { throw new Error("Private evidence could not be decrypted."); }
  finally { key?.fill(0); plaintext?.fill(0); }
}

export async function newPrivateOutputPath(output, extension) {
  if (typeof output !== "string" || !isAbsolute(output) || extname(output) !== extension || /[\r\n\0]/.test(output)) throw new Error("Private output path is invalid.");
  const path = resolve(await realpath(dirname(output)), output.slice(output.lastIndexOf("/") + 1));
  const location = relative(await realpath(checkout), path);
  if (!location.startsWith("../") && location !== "..") throw new Error("Private output must stay outside source.");
  try { await lstat(path); throw new Error(); }
  catch (error) { if (error?.code !== "ENOENT") throw new Error("Private output already exists or is unavailable."); }
  return path;
}
export async function writePrivateOutput(output, value, extension) {
  const path = await newPrivateOutputPath(output, extension);
  await writeFile(path, value, { mode: 0o600, flag: "wx" });
}
export async function readEncryptedInput(input) {
  if (typeof input !== "string" || !isAbsolute(input) || extname(input) !== ".enc" || /[\r\n\0]/.test(input)) throw new Error("Encrypted input is invalid.");
  const file = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_ENVELOPE_BYTES) throw new Error();
    return await file.readFile("utf8");
  } finally { await file.close(); }
}
