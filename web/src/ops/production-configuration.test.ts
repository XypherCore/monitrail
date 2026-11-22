import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfigureArguments, parseConfiguredProductionKeys, readPrivateConfiguration, savePrivateConfiguration } from "../../scripts/deploy/configure-production.ts";

describe("local production configuration safety", () => {
  it("refuses incomplete paginated metadata and selects only production names", () => {
    const envs = [{ key: "DATABASE_URL", target: ["production"], value: "never-return" }, { key: "PREVIEW_ONLY", target: ["preview"] }];
    expect(parseConfiguredProductionKeys({ envs, pagination: { next: null } })).toEqual(["DATABASE_URL"]);
    for (const pagination of [{ next: 12345 }, { next: "cursor" }, "invalid"]) {
      expect(() => parseConfiguredProductionKeys({ envs, pagination })).toThrow();
    }
  });
  it("requires public settings and exactly one explicit operation", () => {
    const args = ["--origin", "https://app.example.invalid", "--abuse-contact", "abuse@example.invalid"];
    expect(parseConfigureArguments([...args, "--prepare-only", "--reuse-oauth-apps"])).toMatchObject({ upload: false, reuseOAuth: true });
    expect(parseConfigureArguments([...args, "--upload"])).toMatchObject({ upload: true, reuseOAuth: false });
    for (const invalid of [args, [...args, "--upload", "--prepare-only"], [...args, "--upload", "--upload"], [...args, "--upload", "--unknown"]]) {
      expect(() => parseConfigureArguments(invalid)).toThrow();
    }
  });
  it("saves generated settings privately and preserves exact values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-config-test-"));
    const path = join(directory, "configuration");
    try {
      await writeFile(path, "DATABASE_URL='synthetic'\n", { mode: 0o644 });
      const file = pathToFileURL(path);
      const original = await readPrivateConfiguration(file);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await savePrivateConfiguration(file, original, { DATABASE_URL: "synthetic", AUTH_SECRET: "private-fixture-value" });
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect(await readFile(path, "utf8")).toContain("AUTH_SECRET='private-fixture-value'");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("refuses source symlinks and stale configuration snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-config-test-"));
    const target = join(directory, "target");
    const link = join(directory, "link");
    try {
      await writeFile(target, "KEY='original'\n");
      await symlink(target, link);
      await expect(readPrivateConfiguration(pathToFileURL(link))).rejects.toThrow();
      const original = await readPrivateConfiguration(pathToFileURL(target));
      await writeFile(target, "KEY='changed-by-owner'\n");
      await expect(savePrivateConfiguration(pathToFileURL(target), original, { KEY: "overwritten" })).rejects.toThrow();
      expect(await readFile(target, "utf8")).toBe("KEY='changed-by-owner'\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it("preserves an existing recovery file and never replaces it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "monitrail-config-test-"));
    const target = join(directory, "configuration");
    try {
      await writeFile(target, "KEY='original'\n");
      const original = await readPrivateConfiguration(pathToFileURL(target));
      await writeFile(`${target}.config-pending`, "existing-recovery-value");
      await expect(savePrivateConfiguration(pathToFileURL(target), original, { KEY: "replacement" })).rejects.toThrow();
      expect(await readFile(`${target}.config-pending`, "utf8")).toBe("existing-recovery-value");
      expect(await readFile(target, "utf8")).toBe("KEY='original'\n");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
