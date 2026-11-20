import { afterEach, describe, expect, it, vi } from "vitest";
import type { DataExecutor } from "../data/access.ts";
import { createHealthHandler, readHealth, STORAGE_LIMIT_BYTES } from "./health.ts";

function database(ageSeconds: unknown, storageBytes: unknown): DataExecutor {
  return { execute: vi.fn(async () => ({ rows: [{ ageSeconds, storageBytes }] })) };
}

describe("public health", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires a recent checker heartbeat and space below the storage threshold", async () => {
    expect(await readHealth(database(0, 1))).toBe(true);
    expect(await readHealth(database(179.999, STORAGE_LIMIT_BYTES * 0.9 - 1))).toBe(true);
    expect(await readHealth(database(180, 1))).toBe(false);
    expect(await readHealth(database(181, 1))).toBe(false);
    expect(await readHealth(database(0, STORAGE_LIMIT_BYTES * 0.9))).toBe(false);
    expect(await readHealth(database(0, STORAGE_LIMIT_BYTES))).toBe(false);
  });

  it("fails closed for missing, future, malformed or unreadable measurements", async () => {
    for (const age of [null, undefined, NaN, Infinity, -1, "0"]) {
      expect(await readHealth(database(age, 1))).toBe(false);
    }
    for (const bytes of [null, undefined, NaN, Infinity, -1, "1"]) {
      expect(await readHealth(database(0, bytes))).toBe(false);
    }
    expect(await readHealth({ execute: async () => ({ rows: [] }) })).toBe(false);
    const execute = vi.fn(async () => { throw new Error("private-database-fixture"); });
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readHealth({ execute })).toBe(false);
    expect(logger).not.toHaveBeenCalled();
  });

  it("returns empty no-store responses for health, failure and exceptions", async () => {
    for (const healthy of [true, false]) {
      const response = await createHealthHandler(async () => healthy)();
      expect(response.status).toBe(healthy ? 200 : 503);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
    const response = await createHealthHandler(async () => { throw new Error("private-fixture"); })();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

});
