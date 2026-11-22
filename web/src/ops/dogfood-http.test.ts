import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  INTERNAL_BODY_LIMIT_BYTES,
  INTERNAL_CLAIM_PATH,
  INTERNAL_DOGFOOD_EVIDENCE_PATH,
  INTERNAL_NONCE_HEADER,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
} from "../../../shared/checks/signing.ts";
import { createInternalNonceStore } from "../services/internal-nonces.ts";
import type { DogfoodEvidence } from "../services/dogfood-evidence.ts";
import { createDogfoodEvidenceHandler, readDogfoodExportSecret, readDogfoodMonitorIds } from "./dogfood-http.ts";
import { createRollingDogfoodEvidenceCapability } from "./dogfood-service.ts";

const secret = "fixture-dedicated-proof-secret-for-unit-tests";
const checkerSecret = "fixture-checker-secret-must-not-authorize-proof";
const now = new Date("2026-11-22T04:03:02.000Z");
const nonce = "b1000000-0000-4000-8000-000000000001";
const ids = ["b1000000-0000-4000-8000-000000000002", "b1000000-0000-4000-8000-000000000003"];
const evidence: DogfoodEvidence = {
  version: 1, from: "2026-11-21T04:03:02.000Z", to: now.toISOString(), capturedAt: now.toISOString(),
  missingAcceptanceEvidence: 0, monitors: [], checks: [], events: [], incidents: [],
};

async function signed(body = "{}", key = secret, instant = now) {
  return signInternalRequest(key, INTERNAL_DOGFOOD_EVIDENCE_PATH, body, { now: instant, nonce });
}
function request(headers: Headers, body = "{}", path = INTERNAL_DOGFOOD_EVIDENCE_PATH, method = "POST") {
  return new Request(`https://app.example.invalid${path}`, { method, headers, body: method === "POST" ? body : undefined });
}
function setup() {
  const consumeNonce = vi.fn<(value: string) => Promise<boolean>>().mockResolvedValue(true);
  const capture = vi.fn<(monitorIds: string[]) => Promise<DogfoodEvidence>>().mockResolvedValue(evidence);
  const configuredSecret = vi.fn<() => unknown>(() => secret);
  const monitorIds = vi.fn<() => unknown>(() => ids.join(","));
  const handler = createDogfoodEvidenceHandler({ secret: configuredSecret, monitorIds, capture, consumeNonce, now: () => now });
  return { handler, consumeNonce, capture, configuredSecret, monitorIds };
}

describe("narrow signed dogfood export", () => {
  it("refuses configuration that reuses the checker key", () => {
    expect(readDogfoodExportSecret({ DOGFOOD_EXPORT_HMAC_SECRET: secret, INTERNAL_HMAC_SECRET: checkerSecret })).toBe(secret);
    expect(readDogfoodExportSecret({ DOGFOOD_EXPORT_HMAC_SECRET: secret, INTERNAL_HMAC_SECRET: secret })).toBeUndefined();
    expect(readDogfoodExportSecret({ DOGFOOD_EXPORT_HMAC_SECRET: "short" })).toBeUndefined();
  });
  it("accepts an empty signed request and uses only the configured monitor IDs", async () => {
    const f = setup();
    const response = await f.handler(request(await signed()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(evidence);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(f.capture).toHaveBeenCalledExactlyOnceWith(ids);
    expect(f.consumeNonce).toHaveBeenCalledExactlyOnceWith(nonce);
  });

  it("refuses the checker key and signatures for another internal path", async () => {
    const f = setup();
    const wrongKey = await f.handler(request(await signed("{}", checkerSecret)));
    const wrongPath = await f.handler(request(await signInternalRequest(secret, INTERNAL_CLAIM_PATH, "{}", { now, nonce })));
    expect(wrongKey.status).toBe(401);
    expect(wrongPath.status).toBe(401);
    expect(f.consumeNonce).not.toHaveBeenCalled();
    expect(f.capture).not.toHaveBeenCalled();
  });

  it.each(["", "null", "[]", '{"from":"2026-01-01"}', `{"monitorIds":["${ids[0]}"]}`, '{"__proto__":{}}'])
  ("refuses nonempty or malformed signed bodies %j", async (body) => {
    const f = setup();
    const response = await f.handler(request(await signed(body), body));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.capture).not.toHaveBeenCalled();
  });

  it.each([-61, 61])("rejects %s-second skew", async (seconds) => {
    const f = setup();
    expect((await f.handler(request(await signed("{}", secret, new Date(now.getTime() + seconds * 1000))))).status).toBe(401);
    expect(f.consumeNonce).not.toHaveBeenCalled();
  });

  it.each([
    [INTERNAL_TIMESTAMP_HEADER, "0000123"],
    [INTERNAL_NONCE_HEADER, `${nonce},${nonce}`],
    [INTERNAL_SIGNATURE_HEADER, "A".repeat(64)],
  ])("rejects a noncanonical %s", async (key, value) => {
    const f = setup();
    const headers = await signed();
    headers.set(key, value);
    expect((await f.handler(request(headers))).status).toBe(401);
    expect(f.capture).not.toHaveBeenCalled();
  });

  it("rejects URL query strings and wrong methods without side effects", async () => {
    const f = setup();
    const query = await f.handler(request(await signed(), "{}", `${INTERNAL_DOGFOOD_EVIDENCE_PATH}?from=arbitrary`));
    const method = await f.handler(request(await signed(), "{}", INTERNAL_DOGFOOD_EVIDENCE_PATH, "GET"));
    expect(query.status).toBe(401);
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    expect(method.headers.get("cache-control")).toBe("no-store");
    expect(f.consumeNonce).not.toHaveBeenCalled();
  });

  it("retains the existing body and content-type limits", async () => {
    const f = setup();
    const headers = await signed();
    headers.set("content-length", String(INTERNAL_BODY_LIMIT_BYTES + 1));
    expect((await f.handler(request(headers))).status).toBe(413);
    const wrongType = await signed();
    wrongType.set("content-type", "text/plain");
    expect((await f.handler(request(wrongType))).status).toBe(415);
    expect(f.consumeNonce).not.toHaveBeenCalled();
  });

  it("fails closed on absent keys, invalid selected IDs and raw service failures", async () => {
    const f = setup();
    f.configuredSecret.mockReturnValueOnce(undefined);
    expect((await f.handler(request(await signed()))).status).toBe(503);
    for (const value of [undefined, "", ids[0], `${ids[0]},${ids[0]}`, `${ids.join(",")},${nonce}`, `${ids[0]}, ${ids[1]}`]) {
      f.monitorIds.mockReturnValueOnce(value);
      const response = await f.handler(request(await signed()));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Internal request could not be completed." });
    }
    f.capture.mockRejectedValueOnce(new Error("postgres://private-secret@private-host"));
    const failed = await f.handler(request(await signed()));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private-secret");
  });
});

describe("database-backed proof export", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  beforeAll(async () => {
    client = new PGlite(); db = drizzle(client);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
    const owner = randomUUID();
    await client.query("INSERT INTO users(id,name) VALUES ($1,'private-owner')", [owner]);
    for (const id of ids) await client.query(`INSERT INTO monitors(id,user_id,name,url,host,created_at) VALUES ($1,$2,'private-name','https://private.example.invalid/path?secret=private-value','private.example.invalid',now()-interval '2 days')`, [id, owner]);
  }, 30_000);
  afterAll(async () => { await client?.close(); });

  it("uses the database clock and a fixed rolling day while exposing no target or owner fields", async () => {
    const before = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0].at;
    const result = await createRollingDogfoodEvidenceCapability(db).capture(ids);
    const after = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0].at;
    expect(Date.parse(result.to)).toBeGreaterThanOrEqual(new Date(before).getTime());
    expect(Date.parse(result.to)).toBeLessThanOrEqual(new Date(after).getTime());
    expect(Date.parse(result.to) - Date.parse(result.from)).toBe(24 * 60 * 60 * 1000);
    expect(result.monitors.map(m => m.id)).toEqual(ids);
    expect(JSON.stringify(result)).not.toMatch(/private-owner|private-name|private-value|https:\/\//);
  });

  it("reuses durable replay protection across handler instances", async () => {
    const store = createInternalNonceStore(db);
    const capture = vi.fn().mockResolvedValue(evidence);
    const dependencies = { secret: () => secret, monitorIds: () => ids.join(","), capture, consumeNonce: store.consume, now: () => now };
    const first = createDogfoodEvidenceHandler(dependencies), second = createDogfoodEvidenceHandler(dependencies);
    expect((await first(request(await signed()))).status).toBe(200);
    expect((await second(request(await signed()))).status).toBe(401);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("requires exactly two distinct canonical UUIDs", () => {
    expect(readDogfoodMonitorIds(ids.join(","))).toEqual(ids);
    expect(() => readDogfoodMonitorIds(`${ids[0].toUpperCase()},${ids[1]}`)).toThrow();
  });
});
