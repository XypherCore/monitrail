import { describe, expect, it } from "vitest";
import {
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_CLAIM_PATH,
  INTERNAL_INGEST_PATH,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from "./signing.ts";

const secret = "fixture-internal-secret-for-unit-tests";
const now = new Date("2026-11-08T01:02:03.999Z");
const nonce = "00000000-0000-4000-8000-000000000001";

describe("portable internal request signing", () => {
  // Vectors calculated independently with Node createHash and createHmac.
  it.each([
    ["", "e23b29b481a728a3896cec0e4bdf30fa2fab27658686bea2c830c4881aa60082"],
    ['{"max":15,"note":"雪"}', "cfe0352577e357eb681e2b15668c9bf5e83b6f67471dac5743eeea29220b7073"],
  ])("matches independent Node HMAC over exact UTF-8 body %j", async (body, expected) => {
    const headers = await signInternalRequest(secret, INTERNAL_CLAIM_PATH, body, { now, nonce });
    const timestamp = String(Math.floor(now.getTime() / 1000));
    expect(headers.get(INTERNAL_TIMESTAMP_HEADER)).toBe(timestamp);
    expect(headers.get(INTERNAL_NONCE_HEADER)).toBe(nonce);
    expect(headers.get(INTERNAL_SIGNATURE_HEADER)).toBe(expected);
  });

  it("binds the path and generates a fresh default nonce", async () => {
    const claim = await signInternalRequest(secret, INTERNAL_CLAIM_PATH, "{}", { now, nonce });
    const ingest = await signInternalRequest(secret, INTERNAL_INGEST_PATH, "{}", { now, nonce });
    expect(claim.get(INTERNAL_SIGNATURE_HEADER)).not.toBe(ingest.get(INTERNAL_SIGNATURE_HEADER));
    const first = await signInternalRequest(secret, INTERNAL_INGEST_PATH, "{}", { now });
    const second = await signInternalRequest(secret, INTERNAL_INGEST_PATH, "{}", { now });
    expect(first.get(INTERNAL_NONCE_HEADER)).not.toBe(second.get(INTERNAL_NONCE_HEADER));
  });

  it("rejects invalid signing inputs without echoing them", async () => {
    await expect(signInternalRequest("short", INTERNAL_CLAIM_PATH, "{}")).rejects.toThrow(
      "Invalid internal request configuration.",
    );
    await expect(signInternalRequest(secret, INTERNAL_CLAIM_PATH, "é".repeat(INTERNAL_BODY_LIMIT_BYTES)))
      .rejects.toThrow("Invalid internal request configuration.");
    await expect(signInternalRequest(secret, INTERNAL_CLAIM_PATH, "{}", { nonce: "unsafe" }))
      .rejects.toThrow("Invalid internal request configuration.");
  });
});
