import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { cliEnvironment, parseConfigureArguments, parseConfiguredProductionKeys, prepareConfiguredProductionEnvironment, readPrivateConfiguration, savePrivateConfiguration } from "../../scripts/deploy/configure-production.ts";
import { prepareProductionEnvironment } from "./production-environment.ts";

const publicArgs = ["--origin", "https://app.example.invalid", "--abuse-contact", "abuse@example.invalid"] as const;
const proofIds = "a1000000-0000-4000-8000-000000000001,a1000000-0000-4000-8000-000000000002";
const runtime = "postgres://monitrail_app.fixture:synthetic-password@aws-0-fixture.pooler.supabase.com:6543/postgres";
const admin = runtime.replace("monitrail_app.", "postgres.").replace("6543", "5432");
const providers = {
  AUTH_GITHUB_ID: "synthetic-github-client", AUTH_GITHUB_SECRET: "synthetic-github-client-secret",
  AUTH_GOOGLE_ID: "synthetic-google-client", AUTH_GOOGLE_SECRET: "synthetic-google-client-secret",
};

describe("local production configuration safety", () => {
  it("passes only the selected provider's tool credentials to each CLI", () => {
    const ambient = { PATH: "/fixture/bin", VERCEL_TOKEN: "vercel-credential-fixture", GH_TOKEN: "github-credential-fixture", DATABASE_URL: "never-inherit", INTERNAL_HMAC_SECRET: "never-inherit" };
    expect(cliEnvironment("vercel", ambient)).toMatchObject({ PATH: ambient.PATH, VERCEL_TOKEN: ambient.VERCEL_TOKEN });
    expect(cliEnvironment("vercel", ambient).GH_TOKEN).toBeUndefined();
    expect(cliEnvironment("github", ambient)).toMatchObject({ PATH: ambient.PATH, GH_TOKEN: ambient.GH_TOKEN });
    expect(cliEnvironment("github", ambient).VERCEL_TOKEN).toBeUndefined();
    expect(cliEnvironment("github", ambient).DATABASE_URL).toBeUndefined();
    expect(cliEnvironment("vercel", ambient).INTERNAL_HMAC_SECRET).toBeUndefined();
  });
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
    expect(parseConfigureArguments([...args, "--upload", "--enable-proof-capture"])).toMatchObject({ proofCapture: true });
    for (const invalid of [args, [...args, "--upload", "--prepare-only"], [...args, "--upload", "--upload"], [...args, "--upload", "--unknown"]]) {
      expect(() => parseConfigureArguments(invalid)).toThrow();
    }
  });
  it.each(["--upload", "--prepare-only"])("accepts explicit proof monitor selection with proof capture in %s mode", (mode) => {
    const parsed = parseConfigureArguments([...publicArgs, mode, "--enable-proof-capture", "--proof-monitor-ids", proofIds]);
    expect(parsed).toMatchObject({ proofCapture: true, proofMonitorIds: proofIds, upload: mode === "--upload" });
    expect(parseConfigureArguments([...publicArgs, mode])).not.toHaveProperty("proofMonitorIds");
  });
  it.each([
    { args: ["--upload", "--proof-monitor-ids", proofIds] },
    { args: ["--upload", "--enable-proof-capture", "--proof-monitor-ids"] },
    { args: ["--upload", "--enable-proof-capture", "--proof-monitor-ids", ""] },
    { args: ["--upload", "--proof-monitor-ids", "--enable-proof-capture"] },
    { args: ["--upload", "--enable-proof-capture", "--proof-monitor-ids", proofIds, "--proof-monitor-ids", proofIds] },
    { args: ["--upload", "--enable-proof-capture", "--proof-monitor-ids", proofIds, "extra-private-value"] },
  ])("rejects missing, duplicate or ambiguous proof selection arguments before preparation (%j)", ({ args }) => {
    expect(() => parseConfigureArguments([...publicArgs, ...args])).toThrow();
  });
  it.each(["--upload", "--prepare-only"])("overlays only the selected proof IDs and preserves existing keys in %s mode", (mode) => {
    const first = prepareProductionEnvironment(
      { DATABASE_URL: runtime, MIGRATION_DATABASE_URL: admin, PRIVATE_OPERATOR_VALUE: "private-synthetic-operator-value", DATABASE_CA_FILE: ".certs/fixture.crt" },
      { origin: publicArgs[1], abuseContact: publicArgs[3], proofCapture: true }, providers,
    );
    const original = { ...first.saved };
    const args = parseConfigureArguments([...publicArgs, mode, "--enable-proof-capture", "--proof-monitor-ids", proofIds.toUpperCase()]);
    const prepared = prepareConfiguredProductionEnvironment(first.saved, args);
    expect(first.saved).toEqual(original);
    expect(prepared.saved).toEqual({ ...original, DOGFOOD_EXPORT_MONITOR_IDS: proofIds });
    expect(prepared.runtime.DOGFOOD_EXPORT_MONITOR_IDS).toBe(proofIds);
    expect(prepared.runtime.DOGFOOD_PROOF_KEY).toBeUndefined();
    expect(prepared.runtime.MIGRATION_DATABASE_URL).toBeUndefined();
    expect(prepared.runtime.DATABASE_CA_FILE).toBeUndefined();
    expect(prepared.runtime.PRIVATE_OPERATOR_VALUE).toBeUndefined();
    expect(prepared.saved.DOGFOOD_PROOF_KEY).toBe(original.DOGFOOD_PROOF_KEY);
    expect(prepared.saved.AUTH_SECRET).toBe(original.AUTH_SECRET);
    expect(prepared.saved.INTERNAL_HMAC_SECRET).toBe(original.INTERNAL_HMAC_SECRET);
    expect(prepared.saved.CHANNEL_ENC_KEY).toBe(original.CHANNEL_ENC_KEY);
  });
  it("keeps an existing proof selection when the new flag is omitted", () => {
    const first = prepareProductionEnvironment({ DATABASE_URL: runtime, DOGFOOD_EXPORT_MONITOR_IDS: proofIds }, { origin: publicArgs[1], abuseContact: publicArgs[3], proofCapture: true }, providers);
    const prepared = prepareConfiguredProductionEnvironment(first.saved, parseConfigureArguments([...publicArgs, "--prepare-only", "--enable-proof-capture"]));
    expect(prepared.saved).toEqual(first.saved);
  });
  it.each([
    { proofCapture: false, proofMonitorIds: proofIds },
    { proofCapture: true, proofMonitorIds: "" },
  ])("requires explicit nonempty proof selection at the preparation boundary without altering saved configuration (%j)", (selection) => {
    const first = prepareProductionEnvironment({ DATABASE_URL: runtime }, { origin: publicArgs[1], abuseContact: publicArgs[3], proofCapture: true }, providers);
    const original = { ...first.saved };
    const parsed = parseConfigureArguments([...publicArgs, "--prepare-only"]);
    expect(() => prepareConfiguredProductionEnvironment(first.saved, { ...parsed, ...selection })).toThrow("Production settings are invalid.");
    expect(first.saved).toEqual(original);
  });
  it.each([
    "private-invalid-id", proofIds.split(",")[0], `${proofIds},a1000000-0000-4000-8000-000000000003`,
    `${proofIds.split(",")[0]},${proofIds.split(",")[0]}`,
    `${proofIds.split(",")[0]},${proofIds.split(",")[0].toUpperCase()}`,
    ` ${proofIds}`, `https://private.example.invalid/monitors/${proofIds.split(",")[0]}`,
  ])("rejects invalid or non-distinct proof IDs without exposing them (%j)", (ids) => {
    const first = prepareProductionEnvironment({ DATABASE_URL: runtime }, { origin: publicArgs[1], abuseContact: publicArgs[3], proofCapture: true }, providers);
    const original = { ...first.saved };
    const parsed = parseConfigureArguments([...publicArgs, "--prepare-only", "--enable-proof-capture", "--proof-monitor-ids", ids]);
    const error = (() => { try { prepareConfiguredProductionEnvironment(first.saved, parsed); } catch (reason) { return reason; } })();
    expect(String(error)).toBe("Error: Production settings are invalid.");
    expect(String(error)).not.toContain(ids);
    expect(first.saved).toEqual(original);
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
