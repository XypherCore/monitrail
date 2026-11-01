import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webDirectory = fileURLToPath(new URL("../../", import.meta.url));
const fakeSecret = "fixture-not-a-real-secret";

describe("administrative database commands", () => {
  it.each([
    ["migrate", []],
    ["seed", ["--confirm-test-data"]],
    ["verify-neon", ["--confirm-clean-branch"]],
    ["verify-neon", ["--confirm-existing-fixtures"]],
  ] as const)("%s failures never print connection credentials", (name, args) => {
    const result = spawnSync(process.execPath, [`scripts/db/${name}.ts`, ...args], {
      cwd: webDirectory,
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: `postgresql://fixture:${fakeSecret}@localhost/fixture` },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("failed");
    expect(result.stdout + result.stderr).not.toContain(fakeSecret);
    expect(result.stdout + result.stderr).not.toContain("postgresql://");
  }, 15_000); // Must outlast the bounded 10-second child process timeout.

  it("requires seed opt-in before accessing a database", () => {
    const result = spawnSync(process.execPath, ["scripts/db/seed.ts"], {
      cwd: webDirectory, env: { ...process.env, DATABASE_URL: "" }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("--confirm-test-data");
  }, 15_000);

  it("refuses development seed in a production environment", () => {
    const result = spawnSync(process.execPath, ["scripts/db/seed.ts", "--confirm-test-data"], {
      cwd: webDirectory, env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "" }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("development-only");
  }, 15_000);
});
