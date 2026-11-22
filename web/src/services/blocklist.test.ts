import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { isBlockedHost } from "../../../shared/ssrf/blocklist.ts";
import {
  BLOCKLIST_REASON,
  createBlocklistCapability,
  parseBlockHostArguments,
} from "./blocklist.ts";
import { createCheckCapabilities } from "./checks.ts";

let client: PGlite;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client);
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)),
  });
}, 30_000);
beforeEach(async () => { await client.exec("TRUNCATE users,blocked_hosts,system_heartbeat CASCADE"); });
afterAll(async () => { await client?.close(); });

describe("verified-owner blocklist administration", () => {
  it("requires explicit domain-control confirmation and a transactional admin capability", () => {
    const execute = vi.fn();
    expect(() => createBlocklistCapability({ execute }, { domainControlVerified: true })).toThrow();
    expect(() => createBlocklistCapability(db, { domainControlVerified: false } as never)).toThrow();
    expect(() => createBlocklistCapability(db, { domainControlVerified: true, userId: "fake" } as never)).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it("canonicalizes IDN, case and trailing dots and defaults the CLI to blocking subdomains", async () => {
    const parsed = parseBlockHostArguments(["add", "BÜCHER.Example.", "--apply", "--confirm-domain-control"]);
    expect(parsed).toEqual({
      apply: true,
      command: { action: "add", host: "xn--bcher-kva.example", includeSubdomains: true, reason: BLOCKLIST_REASON },
    });
    await createBlocklistCapability(db, { domainControlVerified: true }).manageBlocklist(parsed.command);
    const rows = (await client.query("SELECT host,include_subdomains AS \"includeSubdomains\",reason FROM blocked_hosts")).rows;
    expect(rows).toEqual([{ host: "xn--bcher-kva.example", includeSubdomains: true, reason: BLOCKLIST_REASON }]);
    expect(isBlockedHost("sub.xn--bcher-kva.example", rows)).toBe(true);
    expect(isBlockedHost("notxn--bcher-kva.example", rows)).toBe(false);
  });

  it("upserts idempotently, preserves creation time and supports exact-host matching", async () => {
    const access = createBlocklistCapability(db, { domainControlVerified: true });
    const first = { action: "add", host: "Example.COM.", includeSubdomains: true, reason: BLOCKLIST_REASON } as const;
    await access.manageBlocklist(first);
    const [{ created_at: createdAt }] = (await client.query<{ created_at: Date }>("SELECT created_at FROM blocked_hosts")).rows;
    await access.manageBlocklist(first);
    await access.manageBlocklist({ ...first, includeSubdomains: false });
    const rows = (await client.query("SELECT host,include_subdomains AS \"includeSubdomains\",created_at FROM blocked_hosts")).rows;
    expect(rows).toEqual([{ host: "example.com", includeSubdomains: false, created_at: createdAt }]);
    expect(isBlockedHost("example.com", rows)).toBe(true);
    expect(isBlockedHost("sub.example.com", rows)).toBe(false);
  });

  it("removes only the canonical exact entry and safely repeats removal", async () => {
    const access = createBlocklistCapability(db, { domainControlVerified: true });
    await access.manageBlocklist({ action: "add", host: "example.com", includeSubdomains: true, reason: BLOCKLIST_REASON });
    await access.manageBlocklist({ action: "add", host: "other.example.com", includeSubdomains: false, reason: BLOCKLIST_REASON });
    await access.manageBlocklist({ action: "remove", host: "EXAMPLE.COM." });
    await access.manageBlocklist({ action: "remove", host: "example.com" });
    expect((await client.query("SELECT host FROM blocked_hosts")).rows).toEqual([{ host: "other.example.com" }]);
  });

  it("normalizes equivalent IPv4 encodings and mapped IPv6 to one policy key", async () => {
    const access = createBlocklistCapability(db, { domainControlVerified: true });
    for (const host of ["0x08080808", "[::ffff:8.8.8.8]"]) {
      await access.manageBlocklist({ action: "add", host, includeSubdomains: true, reason: BLOCKLIST_REASON });
    }
    expect((await client.query("SELECT host FROM blocked_hosts")).rows).toEqual([{ host: "8.8.8.8" }]);
  });

  it("lets the next claim apply the blocked lifecycle and never resumes a monitor on removal", async () => {
    const owner = "a1000000-0000-4000-8000-000000000001";
    const monitor = "a1000000-0000-4000-8000-000000000002";
    await client.query("INSERT INTO users(id,name) VALUES ($1,'Fixture')", [owner]);
    await client.query(`INSERT INTO monitors(id,user_id,name,url,host,next_check_at)
      VALUES ($1,$2,'Fixture','https://sub.example.com','sub.example.com',clock_timestamp()+interval '1 hour')`, [monitor, owner]);
    await client.query(`INSERT INTO incidents(monitor_id,user_id,started_at,confirmed_at,cause)
      VALUES ($1,$2,clock_timestamp()-interval '1 minute',clock_timestamp(),'timeout')`, [monitor, owner]);
    const access = createBlocklistCapability(db, { domainControlVerified: true });
    await access.manageBlocklist({ action: "add", host: "example.com", includeSubdomains: true, reason: BLOCKLIST_REASON });
    const checks = createCheckCapabilities(db);
    expect((await checks.claimChecks({ max: 15 })).jobs).toEqual([]);
    expect((await client.query("SELECT is_paused,pause_reason,config_rev FROM monitors WHERE id=$1", [monitor])).rows)
      .toEqual([{ is_paused: true, pause_reason: "blocked_host", config_rev: 2 }]);
    expect((await client.query("SELECT resolved_reason FROM incidents WHERE monitor_id=$1", [monitor])).rows)
      .toEqual([{ resolved_reason: "blocked" }]);
    await access.manageBlocklist({ action: "remove", host: "example.com" });
    expect((await checks.claimChecks({ max: 15 })).jobs).toEqual([]);
    expect((await client.query("SELECT is_paused,pause_reason FROM monitors WHERE id=$1", [monitor])).rows)
      .toEqual([{ is_paused: true, pause_reason: "blocked_host" }]);
  });

  it("rejects malformed or credential-bearing hosts, arbitrary reasons and extra fields before SQL", async () => {
    const execute = vi.fn();
    const transaction = vi.fn();
    const access = createBlocklistCapability({ execute, transaction }, { domainControlVerified: true });
    for (const host of ["https://example.com", "user:secret@example.com", "example.com/path", "example.com?token=private", "example.com:443", "localhost", "*.example.com", "a".repeat(1025), "example.com\n"]) {
      await expect(access.manageBlocklist({ action: "add", host, includeSubdomains: true, reason: BLOCKLIST_REASON })).rejects.toThrow("Blocklist command was refused.");
    }
    await expect(access.manageBlocklist({ action: "add", host: "example.com", includeSubdomains: true, reason: "arbitrary private text" })).rejects.toThrow("Blocklist command was refused.");
    await expect(access.manageBlocklist({ action: "remove", host: "example.com", userId: "fake" } as never)).rejects.toThrow("Blocklist command was refused.");
    expect(transaction).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("suppresses driver failures without exposing SQL, hosts or credentials", async () => {
    const execute = vi.fn();
    const transaction = vi.fn().mockRejectedValue(new Error("postgres://private:password@example.com secret query"));
    const access = createBlocklistCapability({ execute, transaction }, { domainControlVerified: true });
    await expect(access.manageBlocklist({ action: "remove", host: "example.com" })).rejects.toThrow("Blocklist update could not be completed.");
  });
});

describe("block-host command entry point", () => {
  it("requires one explicit mode and rejects unknown, repeated and conflicting arguments", () => {
    for (const args of [
      [], ["add", "example.com"], ["add", "example.com", "--apply"],
      ["add", "example.com", "--dry-run", "--apply", "--confirm-domain-control"],
      ["add", "example.com", "--dry-run", "--dry-run"],
      ["add", "example.com", "--dry-run", "--reason", "private"],
      ["remove", "example.com", "--dry-run", "--exact-host"],
      ["list", "example.com", "--dry-run"],
    ]) expect(() => parseBlockHostArguments(args)).toThrow("Blocklist command was refused.");
    expect(parseBlockHostArguments(["add", "example.com", "--dry-run", "--exact-host"])).toEqual({
      apply: false,
      command: { action: "add", host: "example.com", includeSubdomains: false, reason: BLOCKLIST_REASON },
    });
  });

  it("dry-runs without a database connection and reports only generic validation", () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../../scripts/admin/block-host.ts", import.meta.url)),
      "add", "example.com", "--dry-run",
    ], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: "test" } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Blocklist command validated. No database changes made.\n");
    expect(result.stderr).not.toContain("example.com");
  });

  it("refuses incomplete confirmation without printing supplied addresses or connection values", () => {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL("../../scripts/admin/block-host.ts", import.meta.url)),
      "add", "secret.example.com", "--apply",
    ], { encoding: "utf8", timeout: 10_000, env: { PATH: process.env.PATH, NODE_ENV: "test", MIGRATION_DATABASE_URL: "postgres://private:secret@invalid" } });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Blocklist command was refused.");
    expect(result.stderr).not.toContain("secret.example.com");
    expect(result.stderr).not.toContain("postgres://");
  });
});
