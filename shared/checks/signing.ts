export const INTERNAL_BODY_LIMIT_BYTES = 256 * 1024;
export const INTERNAL_CLOCK_SKEW_SECONDS = 60;
export const INTERNAL_NONCE_TTL_SECONDS = 120;
export const INTERNAL_CLAIM_PATH = "/api/internal/claim";
export const INTERNAL_INGEST_PATH = "/api/internal/ingest";
export type InternalPath = typeof INTERNAL_CLAIM_PATH | typeof INTERNAL_INGEST_PATH;

export const INTERNAL_TIMESTAMP_HEADER = "x-monitrail-ts";
export const INTERNAL_NONCE_HEADER = "x-monitrail-nonce";
export const INTERNAL_SIGNATURE_HEADER = "x-monitrail-sig";

const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isInternalUuid(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value);
}

export function isInternalSecret(value: unknown): value is string {
  return typeof value === "string" && value.length >= 32 && value === value.trim();
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeInternalSignature(
  secret: string,
  path: InternalPath,
  timestamp: string,
  nonce: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const bodyHash = await crypto.subtle.digest("SHA-256", body);
  const canonical = `v1\nPOST\n${path}\n${timestamp}\n${nonce}\n${hex(bodyHash)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
}

export async function signInternalRequest(
  secret: string,
  path: InternalPath,
  body: string,
  clock: Readonly<{ now?: Date; nonce?: string }> = {},
): Promise<Headers> {
  const seconds = Math.floor((clock.now ?? new Date()).getTime() / 1000);
  const nonce = clock.nonce ?? crypto.randomUUID();
  const bytes = new Uint8Array(encoder.encode(body));
  if (
    !isInternalSecret(secret) ||
    (path !== INTERNAL_CLAIM_PATH && path !== INTERNAL_INGEST_PATH) ||
    !Number.isSafeInteger(seconds) || seconds < 0 ||
    !isInternalUuid(nonce) ||
    bytes.byteLength > INTERNAL_BODY_LIMIT_BYTES
  ) throw new Error("Invalid internal request configuration.");
  const timestamp = String(seconds);
  const signature = await computeInternalSignature(secret, path, timestamp, nonce, bytes);
  return new Headers({
    "content-type": "application/json",
    [INTERNAL_TIMESTAMP_HEADER]: timestamp,
    [INTERNAL_NONCE_HEADER]: nonce,
    [INTERNAL_SIGNATURE_HEADER]: hex(signature),
  });
}
