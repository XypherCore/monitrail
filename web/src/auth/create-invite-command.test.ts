import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates } from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createInvite, openInviteOutput, parseInviteArguments, type InviteStore } from "../../scripts/auth/create-invite.ts";

const runtime = "postgres://monitrail_app.fixture:fixture-runtime-password@aws-0-test.pooler.supabase.com:6543/postgres";
const caPem = getCACertificates()[0];
const productionFile = new URL("../../.env.production.local", import.meta.url);
const savedConfiguration = `DATABASE_URL=${runtime}\nDATABASE_CA_PEM="${caPem}"\n`;

describe("explicit local and production invite creation", () => {
  let client: PGlite;
  let directory: string;
  let failCommit = false;
  let beforeCommit: (() => Promise<void>) | undefined;
  const close = vi.fn(async () => {});
  const store: InviteStore = {
    async transaction(action) {
      await client.transaction(async (transaction) => {
        await action({ insertHash: async (hash) => { await transaction.query("INSERT INTO invites(code_hash) VALUES ($1)", [hash]); } });
        await beforeCommit?.();
        if (failCommit) throw new Error("private-fixture-commit-detail");
      });
    },
    close,
  };
  beforeAll(async () => {
    client = new PGlite();
    await migrate(drizzle(client), { migrationsFolder: fileURLToPath(new URL("../../drizzle-rev2", import.meta.url)) });
  }, 30000);
  beforeEach(async () => {
    await client.exec("TRUNCATE invites");
    directory = await mkdtemp(join(tmpdir(), "monitrail-invite-command-"));
    failCommit = false;
    beforeCommit = undefined;
    close.mockClear();
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("DATABASE_CA_FILE", undefined);
    vi.stubEnv("DATABASE_CA_PEM", undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  afterAll(async () => { await client.close(); });

  function dependencies() {
    const path = (file: URL) => join(directory, file.pathname.split("/").at(-1) ?? "invalid");
    return {
      openStore: vi.fn((_url: string, _options: ReturnType<typeof import("../../src/db/postgres-config.ts").postgresOptions>) => store),
      readConfiguration: vi.fn(async (_file: URL) => ({ content: savedConfiguration })),
      openOutput: vi.fn(async (file: URL) => openInviteOutput(pathToFileURL(path(file)))),
    };
  }

  it("preserves the development flag and requires an explicit production mode", () => {
    expect(parseInviteArguments(["--confirm-invite"], "development")).toMatchObject({ production: false });
    expect(parseInviteArguments(["--confirm-production-invite"], "production")).toMatchObject({ production: true });
    expect(parseInviteArguments(["--confirm-production-invite"], undefined)).toMatchObject({ production: true });
    for (const args of [[], ["--confirm-invite", "--confirm-production-invite"], ["--confirm-invite", "--confirm-invite"], ["--confirm-invite", "--other"], ["--other"]]) {
      expect(() => parseInviteArguments(args, "development")).toThrow("Invite creation settings are invalid.");
    }
    expect(() => parseInviteArguments(["--confirm-invite"], "production")).toThrow("Invite creation settings are invalid.");
  });

  it.each([
    ["--confirm-invite", "development", ".env.invite.local"],
    ["--confirm-production-invite", "production", ".env.invite.production.local"],
  ] as const)("writes a fresh private code and stores only its hash (%s)", async (flag, nodeEnv, filename) => {
    const deps = dependencies();
    await createInvite([flag], { DATABASE_URL: runtime, NODE_ENV: nodeEnv }, deps);
    const output = join(directory, filename);
    const content = await readFile(output, "utf8");
    const code = /^INVITE_CODE=([A-Za-z0-9_-]{43})\n$/.exec(content)?.[1];
    expect(code).toBeDefined();
    const rows = (await client.query("SELECT code_hash,used_at,used_by FROM invites")).rows;
    expect(rows).toEqual([{ code_hash: createHash("sha256").update(code ?? "").digest("hex"), used_at: null, used_by: null }]);
    expect(JSON.stringify(rows)).not.toContain(code);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(deps.openOutput).toHaveBeenCalledWith(new URL(`../../${filename}`, import.meta.url));
    expect(deps.openStore).toHaveBeenCalledWith(runtime, expect.objectContaining({ ssl: expect.objectContaining({ rejectUnauthorized: true }) }));
    if (flag === "--confirm-production-invite") {
      expect(deps.readConfiguration).toHaveBeenCalledWith(productionFile);
      expect(deps.openStore.mock.calls[0]?.[1].ssl.ca?.at(-1)).toBe(new X509Certificate(caPem).toString());
    } else expect(deps.readConfiguration).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reads the canonical private production configuration without ambient connection settings", async () => {
    const deps = dependencies();
    await createInvite(["--confirm-production-invite"], { NODE_ENV: "production" }, deps);
    expect(deps.readConfiguration).toHaveBeenCalledExactlyOnceWith(productionFile);
    expect(deps.openStore).toHaveBeenCalledWith(runtime, expect.objectContaining({ ssl: expect.objectContaining({ rejectUnauthorized: true }) }));
  });

  it("never falls back to an ambient database when the production file omits it", async () => {
    const deps = dependencies();
    deps.readConfiguration.mockResolvedValue({ content: `DATABASE_CA_PEM="${caPem}"\n` });
    await expect(createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps)).rejects.toThrow("Invite creation failed.");
    expect(deps.openStore).not.toHaveBeenCalled();
    expect(deps.openOutput).not.toHaveBeenCalled();
  });

  it.each([
    { DATABASE_URL: runtime.replace("monitrail_app.fixture", "monitrail_app.staging") },
    { DATABASE_CA_FILE: "private-staging-ca-must-not-be-read.crt" },
    { DATABASE_CA_PEM: "private-staging-ca-must-not-be-used" },
  ])("rejects conflicting ambient database and CA settings before connecting (%j)", async (ambient) => {
    const deps = dependencies();
    const error = await createInvite(["--confirm-production-invite"], ambient, deps).catch((failure) => failure);
    expect(String(error)).toBe("Error: Invite creation failed.");
    expect(String(error)).not.toContain("private-staging");
    expect(deps.openStore).not.toHaveBeenCalled();
    expect(deps.openOutput).not.toHaveBeenCalled();
  });

  it("permits matching ambient settings but keeps the saved restricted runtime role and strict TLS", async () => {
    const deps = dependencies();
    await createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime, DATABASE_CA_PEM: caPem }, deps);
    expect(deps.openStore).toHaveBeenCalledWith(runtime, expect.objectContaining({ prepare: false, ssl: expect.objectContaining({ rejectUnauthorized: true }) }));
  });

  it("does not expose private configuration read failures or open a connection", async () => {
    const deps = dependencies();
    deps.readConfiguration.mockRejectedValue(new Error("private-fixture-reader-detail"));
    const error = await createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps).catch((failure) => failure);
    expect(String(error)).toBe("Error: Invite creation failed.");
    expect(deps.openStore).not.toHaveBeenCalled();
    expect(deps.openOutput).not.toHaveBeenCalled();
  });

  it("generates distinct codes and unique hashes on separate completed invitations", async () => {
    const deps = dependencies();
    const env = { DATABASE_URL: runtime, NODE_ENV: "production" };
    await createInvite(["--confirm-production-invite"], env, deps);
    const output = join(directory, ".env.invite.production.local");
    const first = await readFile(output, "utf8");
    await unlink(output);
    await createInvite(["--confirm-production-invite"], env, deps);
    expect(await readFile(output, "utf8")).not.toBe(first);
    const rows = (await client.query("SELECT code_hash FROM invites")).rows as { code_hash: string }[];
    expect(new Set(rows.map((row) => row.code_hash)).size).toBe(2);
  });

  it("rolls back the hash when an existing private output file refuses creation", async () => {
    const deps = dependencies();
    const output = join(directory, ".env.invite.production.local");
    await writeFile(output, "existing-private-fixture", { mode: 0o600 });
    await expect(createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps)).rejects.toThrow("Invite creation failed.");
    expect((await client.query("SELECT code_hash FROM invites")).rows).toHaveLength(0);
    expect(await readFile(output, "utf8")).toBe("existing-private-fixture");
    expect(deps.openOutput).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(["write", "close"] as const)("rolls back and removes its partially created output after a %s failure", async (failure) => {
    const deps = dependencies();
    const outputPath = join(directory, ".env.invite.production.local");
    const output = await openInviteOutput(pathToFileURL(outputPath));
    const closeOutput = vi.fn(output.close);
    deps.openOutput.mockResolvedValue({
      ...output,
      async writeFile(content: string) {
        if (failure === "write") {
          await output.writeFile(content.slice(0, 18));
          throw new Error("private-partial-write-detail");
        }
        await output.writeFile(content);
      },
      async close() {
        await closeOutput();
        if (failure === "close") throw new Error("private-close-detail");
      },
    });
    const error = await createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps).catch((reason) => reason);
    expect(String(error)).toBe("Error: Invite creation failed.");
    expect(closeOutput).toHaveBeenCalled();
    expect((await client.query("SELECT code_hash FROM invites")).rows).toHaveLength(0);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the private output before allowing the database transaction to commit", async () => {
    const deps = dependencies();
    const output = await openInviteOutput(pathToFileURL(join(directory, ".env.invite.production.local")));
    const closeOutput = vi.fn(output.close);
    deps.openOutput.mockResolvedValue({ ...output, close: closeOutput });
    beforeCommit = async () => { expect(closeOutput).toHaveBeenCalledOnce(); };
    await createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps);
  });

  it("removes only its newly created output when the database commit fails", async () => {
    const deps = dependencies();
    failCommit = true;
    await expect(createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps)).rejects.toThrow("Invite creation failed.");
    expect((await client.query("SELECT code_hash FROM invites")).rows).toHaveLength(0);
    await expect(readFile(join(directory, ".env.invite.production.local"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not remove another file that replaced its output before a commit failure", async () => {
    const deps = dependencies();
    const output = join(directory, ".env.invite.production.local");
    beforeCommit = async () => {
      await unlink(output);
      await writeFile(output, "foreign-private-fixture", { flag: "wx", mode: 0o600 });
    };
    failCommit = true;
    await expect(createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime }, deps)).rejects.toThrow("Invite creation failed.");
    expect((await client.query("SELECT code_hash FROM invites")).rows).toHaveLength(0);
    expect(await readFile(output, "utf8")).toBe("foreign-private-fixture");
  });

  it("refuses an unrestricted runtime role or invalid mode before opening a connection", async () => {
    const deps = dependencies();
    deps.readConfiguration.mockResolvedValue({ content: savedConfiguration.replace("monitrail_app.", "postgres.") });
    const error = await createInvite(["--confirm-production-invite"], { DATABASE_URL: runtime.replace("monitrail_app.", "postgres.") }, deps).catch((failure) => failure);
    expect(String(error)).toBe("Error: Invite creation failed.");
    expect(String(error)).not.toContain("fixture-runtime-password");
    await expect(createInvite(["--confirm-invite"], { DATABASE_URL: runtime, NODE_ENV: "production" }, deps)).rejects.toThrow("Invite creation failed.");
    expect(deps.openStore).not.toHaveBeenCalled();
    expect(deps.openOutput).not.toHaveBeenCalled();
  });
});
